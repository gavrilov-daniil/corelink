import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROBE_URL, type ProbeTarget, type XrayConfig } from "@corelink/xray-config";

export interface ProbeOutcome {
  tag: string;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

/** Исполнитель пробы. Отдельный тип — чтобы тест проверял учёт результатов, не поднимая Xray. */
export type ProbeExecutor = (config: XrayConfig, targets: ProbeTarget[]) => Promise<ProbeOutcome[]>;

export const PROBE_EXECUTOR = Symbol("PROBE_EXECUTOR");

/**
 * Сбой самой пробы (нет xray/curl, Xray пробы не поднялся) — не падение нод. Такой
 * прогон не пишет результатов: иначе один отсутствующий бинарь нарисовал бы «упали все».
 */
export class ProbeInfraError extends Error {}

const XRAY_BIN = process.env.XRAY_BIN ?? "xray";
const CURL_BIN = process.env.CURL_BIN ?? "curl";
/** Тот же адрес, что пробит observatory в клиентском конфиге: нейтральный, не палит назначение. */
const PROBE_URL = DEFAULT_PROBE_URL;

/**
 * Боевой исполнитель: локальный Xray с SOCKS-входом на канал и curl через каждый вход.
 * Два захода на канал — первый может упереться в холодное установление сессии; успех
 * любого захода = канал работает, задержка — удачного.
 */
export const xrayCurlExecutor: ProbeExecutor = async (config, targets) => {
  if (targets.length === 0) return [];
  const dir = await mkdtemp(join(tmpdir(), "corelink-probe-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });

  const xray = spawn(XRAY_BIN, ["run", "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
  // состояние процесса меняют колбэки — держим его в объекте, а не в let'ах
  const proc = { exited: false, output: "", spawnError: null as Error | null };
  // «Failed to start: …» Xray пишет в stdout, а не в stderr — слушаем оба
  const collect = (chunk: Buffer) => {
    proc.output = (proc.output + chunk.toString("utf8")).slice(-4000);
  };
  xray.stdout.on("data", collect);
  xray.stderr.on("data", collect);
  xray.on("exit", () => {
    proc.exited = true;
  });
  xray.on("error", (err) => {
    proc.spawnError = err;
    proc.exited = true;
  });

  try {
    await waitForPort(targets[0]!.port, 5000, () => proc.exited);
    return await Promise.all(targets.map(probeTarget));
  } catch (err) {
    if (err instanceof ProbeInfraError) throw err;
    const cause = proc.spawnError?.message ?? (err instanceof Error ? err.message : String(err));
    const reason = startupFailure(proc.output);
    throw new ProbeInfraError(`xray пробы не поднялся: ${cause}${reason ? ` — ${reason}` : ""}`);
  } finally {
    xray.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
};

async function probeTarget(target: ProbeTarget): Promise<ProbeOutcome> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await curlThroughSocks(target.port);
    if (res.ok) return { tag: target.tag, ok: true, latencyMs: res.latencyMs, error: null };
    lastError = res.error;
  }
  return { tag: target.tag, ok: false, latencyMs: null, error: lastError };
}

function curlThroughSocks(port: number): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const args = ["-sS", "-o", "/dev/null", "-m", "10", "-x", `socks5h://127.0.0.1:${port}`, "-w", "%{http_code} %{time_total}", PROBE_URL];
  return new Promise((resolve, reject) => {
    execFile(CURL_BIN, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new ProbeInfraError(`нет curl (${CURL_BIN})`));
        return;
      }
      const [code, total] = stdout.trim().split(" ");
      if (code === "204") {
        resolve({ ok: true, latencyMs: Math.round(Number(total) * 1000) });
        return;
      }
      resolve({ ok: false, error: (stderr.trim() || `HTTP ${code || "—"}`).slice(0, 300) });
    });
  });
}

/** Строка с причиной отказа Xray; её нет — последняя строка вывода. */
export function startupFailure(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const failed = lines.filter((l) => /failed|error|invalid/i.test(l)).pop();
  return (failed ?? lines.at(-1) ?? "").slice(0, 400);
}

/** Ждём, пока Xray пробы откроет входы; вышел раньше — дальше ждать нечего. */
async function waitForPort(port: number, timeoutMs: number, hasExited: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited()) throw new Error("процесс завершился");
    if (await canConnect(port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`входы не открылись за ${timeoutMs} мс`);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}
