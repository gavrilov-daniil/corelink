import { Client } from "ssh2";
import type { SshProbeCreds } from "./ssh-probe.js";

/**
 * Выполнение bash-скрипта на сервере по SSH со стримом вывода. В отличие от
 * ssh-probe (одна безобидная команда — «доступ есть или нет»), это исполнитель
 * провижина: один коннект, скрипт уходит в `bash -s` через stdin, stdout/stderr
 * стримятся наружу по мере поступления, а результат — код возврата.
 *
 * Почему bash -s, а не exec отдельных команд: провижн-скрипт атомарен (set -e внутри),
 * и гонять его одним потоком проще, чем сериализовать пошаговый exec и склеивать
 * коды. Скрипт в лог не пишется (в нём bootstrap-токен) — наружу идёт только stdout.
 *
 * Способы сломать, ради которых watchdog и единый teardown:
 *   1. Хендшейк прошёл, установка залипла (apt ждёт ввод, сеть встала) — общий
 *      watchdog поверх readyTimeout снимает соединение.
 *   2. Сервер принял TCP, но молчит на хендшейке — тот же watchdog.
 *   3. Двойное разрешение промиса (и 'error', и 'close') — флаг settled.
 */

const DEFAULT_TIMEOUT_MS = 300_000; // 5 мин: apt + установка Xray могут быть долгими
/** Хвост вывода для detail: полный лог копит вызывающий через onChunk. */
const MAX_DETAIL = 2000;

export interface SshRunOptions {
  host: string;
  port: number;
  user: string;
  creds: SshProbeCreds;
  timeoutMs?: number;
}

export interface SshRunResult {
  ok: boolean;
  code: number | null;
  detail: string;
}

export function runSshScript(
  opts: SshRunOptions,
  script: string,
  onChunk: (chunk: string) => void,
): Promise<SshRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<SshRunResult>((resolve) => {
    const conn = new Client();
    let settled = false;
    let tail = "";
    let exitCode: number | null = null;

    const emit = (chunk: string): void => {
      onChunk(chunk);
      tail = (tail + chunk).slice(-MAX_DETAIL);
    };

    const finish = (result: SshRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      conn.end();
      conn.destroy();
      resolve(result);
    };

    const watchdog = setTimeout(
      () => finish({ ok: false, code: null, detail: `таймаут ${timeoutMs} мс: установка не завершилась` }),
      timeoutMs,
    );

    conn.on("ready", () => {
      conn.exec("bash -s", (err, stream) => {
        if (err) return finish({ ok: false, code: null, detail: err.message });
        stream
          .on("exit", (code: number | null) => {
            exitCode = code;
          })
          .on("close", () =>
            finish({
              ok: exitCode === 0,
              code: exitCode,
              detail: tail.trim() || (exitCode === 0 ? "готово" : `код возврата ${exitCode}`),
            }),
          )
          .on("data", (chunk: Buffer) => emit(chunk.toString("utf8")));
        stream.stderr.on("data", (chunk: Buffer) => emit(chunk.toString("utf8")));
        stream.end(script);
      });
    });

    conn.on("error", (err) => finish({ ok: false, code: null, detail: err.message }));

    const base = {
      host: opts.host,
      port: opts.port,
      username: opts.user,
      readyTimeout: Math.min(timeoutMs, 30_000),
    };
    if (opts.creds.kind === "password") {
      conn.connect({ ...base, password: opts.creds.password });
    } else {
      conn.connect({ ...base, privateKey: opts.creds.privateKey, passphrase: opts.creds.passphrase });
    }
  });
}
