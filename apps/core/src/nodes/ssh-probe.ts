import { Client } from "ssh2";

/**
 * Одноразовая проверка SSH-доступа: подключиться, выполнить безобидную команду,
 * вернуть её вывод. Это НЕ клиент для провижна — только «доступ рабочий или нет».
 *
 * Три способа сломать, ради которых тут таймаут и единый teardown:
 *   1. Сервер принял TCP, но не отвечает на хендшейке — без readyTimeout оператор
 *      висит бесконечно, держа сокет. Отсюда общий watchdog поверх readyTimeout.
 *   2. Хендшейк прошёл, но exec не завершается (нода залипла) — тот же watchdog.
 *   3. Двойное разрешение промиса (и 'ready', и 'error' успели прийти) — отсекаем
 *      флагом settled, соединение закрываем ровно один раз.
 *
 * Секреты (пароль/ключ) в detail и в ошибках не попадают: наружу отдаём только
 * текст uname/uptime или сообщение самого ssh2, ключ в него не входит.
 */

const PROBE_COMMAND = "uname -a; uptime";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Обрезаем вывод: залипшая нода может вернуть поток, а нам нужна одна строка для UI. */
const MAX_DETAIL = 600;

export type SshProbeCreds =
  | { kind: "password"; password: string }
  | { kind: "key"; privateKey: string; passphrase?: string };

export interface SshProbeOptions {
  host: string;
  port: number;
  user: string;
  creds: SshProbeCreds;
  timeoutMs?: number;
}

export interface SshProbeResult {
  ok: boolean;
  detail: string;
}

export function probeSsh(opts: SshProbeOptions): Promise<SshProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<SshProbeResult>((resolve) => {
    const conn = new Client();
    let settled = false;

    const finish = (result: SshProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      conn.end();
      conn.destroy();
      resolve(result);
    };

    const watchdog = setTimeout(
      () => finish({ ok: false, detail: `таймаут ${timeoutMs} мс: сервер не ответил` }),
      timeoutMs,
    );

    conn.on("ready", () => {
      conn.exec(PROBE_COMMAND, (err, stream) => {
        if (err) return finish({ ok: false, detail: err.message });
        let out = "";
        stream
          .on("close", () => finish({ ok: true, detail: out.trim().slice(0, MAX_DETAIL) || "подключение успешно" }))
          .on("data", (chunk: Buffer) => {
            out += chunk.toString("utf8");
          });
        stream.stderr.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
      });
    });

    conn.on("error", (err) => finish({ ok: false, detail: err.message }));

    const base = {
      host: opts.host,
      port: opts.port,
      username: opts.user,
      readyTimeout: timeoutMs,
    };
    if (opts.creds.kind === "password") {
      conn.connect({ ...base, password: opts.creds.password });
    } else {
      conn.connect({ ...base, privateKey: opts.creds.privateKey, passphrase: opts.creds.passphrase });
    }
  });
}
