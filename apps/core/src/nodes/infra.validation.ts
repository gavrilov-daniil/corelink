import { BadRequestException } from "@nestjs/common";

/**
 * Проверка входа админского CRUD по сети.
 *
 * Мусор отвергается на границе, а не генератором конфига: неверный порт или тег,
 * пролезший в БД, ломает не запрос оператора, а сборку desired-state ВСЕХ нод
 * профиля — то есть в другом месте и позже, чем его завели.
 *
 * Пара `str`/`nullableStr` (и аналоги) разведена намеренно: у not-null колонок
 * тип не должен допускать null, иначе проверка «null нельзя» жила бы только в рантайме.
 */

export const NODE_ROLES = ["exit", "relay", "front"] as const;
export const NODE_STATUSES = ["provisioning", "active", "disabled", "retiring"] as const;

/**
 * Способ SSH-доступа. vault_ref — доступ описан ссылкой (ssh_ref), сам секрет в БД
 * не лежит и платформа по нему не ходит; password/key — секрет в ssh_secret.
 */
export const SSH_AUTH_TYPES = ["password", "key", "vault_ref"] as const;
export type SshAuthType = (typeof SSH_AUTH_TYPES)[number];

/**
 * Генератор ноды (buildNodeConfig) собирает ровно vless+reality. Строка с другим
 * протоколом или security приехала бы на ноду всё тем же reality-инбаундом, то есть
 * значение в БД врало бы про то, что реально работает.
 */
export const INBOUND_PROTOCOLS = ["vless"] as const;
export const INBOUND_SECURITY = ["reality"] as const;
export const INBOUND_NETWORKS = ["tcp", "grpc", "xhttp", "ws"] as const;
/** vision живёт только на tcp: на мультиплексируемых транспортах Xray его не принимает. */
export const INBOUND_FLOWS = ["", "xtls-rprx-vision"] as const;
/** uTLS-отпечатки Xray. Неизвестное значение нода не поднимет. */
export const FINGERPRINTS = [
  "chrome",
  "firefox",
  "safari",
  "ios",
  "android",
  "edge",
  "360",
  "qq",
  "random",
  "randomized",
] as const;

const ALPN_VALUES = ["h2", "http/1.1", "h3"];

/** Тег ссылается из routing-правил и из селектора балансера — пробелы и кавычки там недопустимы. */
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
/** shortId Reality — hex чётной длины, максимум 8 байт. */
const SHORT_ID_RE = /^(?:[0-9a-f]{2}){1,8}$/;
/** x25519-ключ Reality: 32 байта в base64url без выравнивания — ровно 43 символа. */
const REALITY_PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;

export type Raw = Record<string, unknown>;

export function bad(message: string): never {
  throw new BadRequestException(message);
}

/** Присланное поле. Отсутствие ≠ null: первое «не трогать», второе «обнулить». */
export function has(raw: Raw, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined;
}

interface StrOpts {
  required?: boolean;
  max?: number;
  pattern?: RegExp;
  hint?: string;
  lower?: boolean;
  upper?: boolean;
  allowEmpty?: boolean;
}

function readStr(raw: Raw, key: string, opts: StrOpts, nullable: boolean): string | null | undefined {
  if (!has(raw, key)) {
    if (opts.required) bad(`${key}: обязательное поле`);
    return undefined;
  }
  const value = raw[key];
  if (value === null) {
    if (opts.required) bad(`${key}: обязательное поле`);
    if (!nullable) bad(`${key}: null недопустим`);
    return null;
  }
  if (typeof value !== "string") bad(`${key}: ожидается строка`);
  let out = (value as string).trim();
  if (opts.lower) out = out.toLowerCase();
  if (opts.upper) out = out.toUpperCase();
  if (out.length === 0 && !opts.allowEmpty) {
    if (opts.required) bad(`${key}: обязательное поле`);
    if (nullable) return null;
    bad(`${key}: пустая строка`);
  }
  if (opts.max !== undefined && out.length > opts.max) bad(`${key}: длиннее ${opts.max} символов`);
  if (out.length > 0 && opts.pattern && !opts.pattern.test(out)) {
    bad(`${key}: недопустимое значение${opts.hint ? ` (${opts.hint})` : ""}`);
  }
  return out;
}

export function str(raw: Raw, key: string, opts: StrOpts = {}): string | undefined {
  return readStr(raw, key, opts, false) ?? undefined;
}

export function nullableStr(raw: Raw, key: string, opts: StrOpts = {}): string | null | undefined {
  return readStr(raw, key, opts, true);
}

interface NumOpts {
  required?: boolean;
  min?: number;
  max?: number;
}

export function num(raw: Raw, key: string, opts: NumOpts = {}): number | undefined {
  if (!has(raw, key)) {
    if (opts.required) bad(`${key}: обязательное поле`);
    return undefined;
  }
  const value = raw[key];
  if (typeof value !== "number" || !Number.isInteger(value)) bad(`${key}: ожидается целое число`);
  const n = value as number;
  if (opts.min !== undefined && n < opts.min) bad(`${key}: минимум ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) bad(`${key}: максимум ${opts.max}`);
  return n;
}

export function bool(raw: Raw, key: string): boolean | undefined {
  if (!has(raw, key)) return undefined;
  if (typeof raw[key] !== "boolean") bad(`${key}: ожидается true/false`);
  return raw[key] as boolean;
}

export function obj(raw: Raw, key: string): Record<string, unknown> | undefined {
  if (!has(raw, key)) return undefined;
  const value = raw[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(`${key}: ожидается JSON-объект`);
  return value as Record<string, unknown>;
}

function strList(raw: Raw, key: string): string[] | undefined {
  if (!has(raw, key)) return undefined;
  const value = raw[key];
  if (!Array.isArray(value)) bad(`${key}: ожидается массив строк`);
  return (value as unknown[]).map((v) => {
    if (typeof v !== "string") bad(`${key}: ожидается массив строк`);
    return (v as string).trim();
  });
}

export function enumOf<T extends string>(
  raw: Raw,
  key: string,
  allowed: readonly T[],
  opts: { required?: boolean; allowEmpty?: boolean } = {},
): T | undefined {
  const value = str(raw, key, { required: opts.required, lower: true, allowEmpty: opts.allowEmpty });
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) bad(`${key}: допустимы только ${allowed.map((a) => `"${a}"`).join(", ")}`);
  return value as T;
}

export function uuidStr(raw: Raw, key: string, opts: { required?: boolean } = {}): string | undefined {
  return str(raw, key, { ...opts, pattern: UUID_RE, hint: "нужен uuid" });
}

export function requireUuid(value: string, key = "id"): string {
  if (!UUID_RE.test(value)) bad(`${key}: нужен uuid`);
  return value;
}

export function portNum(raw: Raw, key: string, opts: { required?: boolean } = {}): number | undefined {
  return num(raw, key, { required: opts.required, min: 1, max: 65535 });
}

export function isIp(value: string): boolean {
  return IPV4_RE.test(value) || (value.includes(":") && IPV6_RE.test(value));
}

export function ipStr(raw: Raw, key: string, opts: { required?: boolean } = {}): string | undefined {
  const value = str(raw, key, opts);
  if (value !== undefined && !isIp(value)) bad(`${key}: нужен IPv4 или IPv6`);
  return value;
}

export function ipArray(raw: Raw, key: string): string[] | undefined {
  const values = strList(raw, key);
  if (!values) return undefined;
  for (const v of values) if (!isIp(v)) bad(`${key}: «${v}» не похож на IP`);
  return values;
}

/** Адрес endpoint'а в подписке: и IP, и домен допустимы. */
export function addressStr(raw: Raw, key: string, opts: { required?: boolean } = {}): string | undefined {
  const value = str(raw, key, { ...opts, max: 253 });
  if (value === undefined) return undefined;
  if (!isIp(value) && !HOSTNAME_RE.test(value)) bad(`${key}: нужен IP или доменное имя`);
  return value;
}

export function tagStr(raw: Raw, key: string, opts: { required?: boolean } = {}): string | undefined {
  return str(raw, key, { ...opts, pattern: TAG_RE, hint: "буквы, цифры, . _ - ; до 64 символов" });
}

export function hostnameStr(raw: Raw, key: string, opts: { required?: boolean } = {}): string | undefined {
  return str(raw, key, { ...opts, max: 253, pattern: HOSTNAME_RE, hint: "нужно доменное имя" });
}

/** Имя системного пользователя (useradd допускает такой набор). */
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export function sshUserStr(raw: Raw, key: string): string | null | undefined {
  return nullableStr(raw, key, { max: 32, lower: true, pattern: SSH_USER_RE, hint: "имя linux-пользователя" });
}

export function shortIdArray(raw: Raw, key: string): string[] | undefined {
  const values = strList(raw, key);
  if (!values) return undefined;
  for (const v of values) {
    if (!SHORT_ID_RE.test(v.toLowerCase())) bad(`${key}: «${v}» — не hex чётной длины до 16 символов`);
  }
  return values.map((v) => v.toLowerCase());
}

/**
 * Публичная часть Reality. Мусор здесь — не ошибка запроса, а канал, который
 * поднимется и не заработает: клиент шлёт хендшейк на ключ, которого у ноды нет.
 */
export function realityPubkeyStr(raw: Raw, key: string): string | null | undefined {
  const value = nullableStr(raw, key, { max: 64 });
  if (typeof value === "string" && !REALITY_PUBKEY_RE.test(value)) {
    bad(`${key}: «${value}» — не похож на x25519-ключ (43 символа base64url)`);
  }
  return value;
}

export function shortIdStr(raw: Raw, key: string): string | null | undefined {
  const value = nullableStr(raw, key, { max: 16, lower: true });
  if (typeof value === "string" && !SHORT_ID_RE.test(value)) {
    bad(`${key}: «${value}» — не hex чётной длины до 16 символов`);
  }
  return value;
}

export function roleArray(raw: Raw, key: string, opts: { required?: boolean } = {}): string[] | undefined {
  const values = strList(raw, key);
  if (!values) {
    if (opts.required) bad(`${key}: обязательное поле`);
    return undefined;
  }
  if (values.length === 0) bad(`${key}: нужна хотя бы одна роль`);
  for (const v of values) {
    if (!(NODE_ROLES as readonly string[]).includes(v)) {
      bad(`${key}: «${v}» — допустимы только ${NODE_ROLES.join(", ")}`);
    }
  }
  return [...new Set(values)];
}

/** alpn в host'е — строка вида "h2,http/1.1": так её ждёт клиентский генератор. */
export function alpnStr(raw: Raw, key: string): string | null | undefined {
  const value = nullableStr(raw, key, { max: 64 });
  if (typeof value !== "string") return value;
  for (const part of value.split(",").map((p) => p.trim())) {
    if (!ALPN_VALUES.includes(part)) bad(`${key}: «${part}» — допустимы ${ALPN_VALUES.join(", ")}`);
  }
  return value;
}

/**
 * Согласованность inbound'а как целого. Проверяется отдельно от пополевой валидации,
 * потому что PATCH меняет одно поле, а ломает пару: security=reality без sni — это
 * нода, которая не поднимется, и канал, который молча не заработает.
 */
export function assertInboundShape(row: {
  security: string;
  sni: string | null;
  network: string;
  flow: string;
}): void {
  if (row.security === "reality" && !row.sni) bad("sni: обязателен при security=reality");
  if (row.flow === "xtls-rprx-vision" && row.network !== "tcp") {
    bad(`flow: xtls-rprx-vision работает только на network=tcp (сейчас ${row.network})`);
  }
}
