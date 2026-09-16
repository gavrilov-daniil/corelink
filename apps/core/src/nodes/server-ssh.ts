import { decryptCredentials } from "@corelink/core-kit";
import { schema } from "@corelink/db";
import type { SshProbeCreds } from "./ssh-probe.js";

type ServerRow = typeof schema.server.$inferSelect;

/**
 * Разбор SSH-доступа сервера в параметры подключения: расшифровка секрета и выбор
 * способа (пароль/ключ). Общий для проверки доступа (InfraService) и провижина
 * (ProvisionService) — оба ходят по одному и тому же доступу, дублировать разбор
 * кредов между ними нельзя. vault_ref сюда не годится: это указатель в vault, а не
 * секрет, по которому платформа умеет подключиться.
 */
export type ServerSshResolved =
  | { ok: true; host: string; port: number; user: string; creds: SshProbeCreds }
  | { ok: false; detail: string };

export function resolveServerSsh(row: ServerRow, masterKey: string): ServerSshResolved {
  const authType = row.sshAuthType as ServerRow["sshAuthType"];
  if (authType === "vault_ref") {
    return {
      ok: false,
      detail: "доступ описан ссылкой в vault — платформа по нему не ходит; выберите пароль или ключ",
    };
  }

  let secret: Record<string, string>;
  try {
    secret = decryptCredentials(row.sshSecret, masterKey);
  } catch {
    // Штатный сценарий: сменили SECRETS_MASTER_KEY или подняли дамп со старым ключом.
    return { ok: false, detail: "секрет не читается — проверьте SECRETS_MASTER_KEY" };
  }

  let creds: SshProbeCreds;
  if (authType === "password") {
    if (!secret.password) return { ok: false, detail: "пароль не задан" };
    creds = { kind: "password", password: secret.password };
  } else {
    if (!secret.privateKey) return { ok: false, detail: "приватный ключ не задан" };
    creds = { kind: "key", privateKey: secret.privateKey, passphrase: secret.passphrase || undefined };
  }

  return { ok: true, host: row.primaryIp, port: row.sshPort ?? 22, user: row.sshUser || "root", creds };
}
