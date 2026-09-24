import { createHash } from "node:crypto";
import type { XrayConfig } from "./types.js";

export type NodeRole = "exit" | "relay" | "front";

export interface RealityIdentity {
  publicKey: string;
  /** Приватник НИКОГДА не приходит из панели — он живёт на ноде. Здесь его нет намеренно. */
  shortIds: string[];
  sni: string;
  fingerprint: string;
}

export interface NodeInbound {
  tag: string;
  port: number;
  role: NodeRole;
  reality: RealityIdentity;
  flow?: string; // vision на tcp; пусто на grpc/xhttp
  network?: string;
  /** reality (self-handshake, серт не нужен) | tls (серт на ноде, вариант B) | none (TLS терминирует CDN, вариант A). */
  security?: string;
  serviceName?: string; // grpc
  path?: string; // ws/xhttp
  host?: string; // ws/xhttp — Host-заголовок / :authority
}

/** Пользователь inbound'а. Для каскада это служебный link-user, представляющий relay на exit'е. */
export interface NodeUser {
  email: string;
  uuid: string;
  level?: number;
  inboundTag: string;
}

/** Плечо server-forward каскада на стороне relay: outbound CASCADE_<CC> + правило inbound→outbound. */
export interface CascadeOutbound {
  tag: string; // CASCADE_<CC>
  cc: string;
  fromInboundTag: string;
  exit: {
    address: string;
    port: number;
    uuid: string; // link_user_uuid — детерминированный (uuidv5), не рандом
    reality: RealityIdentity;
    flow: string;
  };
}

export interface NodeConfigInput {
  role: NodeRole;
  inbounds: NodeInbound[];
  users: NodeUser[];
  cascades?: CascadeOutbound[];
  /** Блокировать SMTP на выход — один спамер убивает репутацию IP всей подсети. */
  blockOutboundSmtp?: boolean;
  logLevel?: string;
}

const API_TAG = "api";
const API_PORT = 10085;

/**
 * Приватные, loopback, link-local и CGNAT-диапазоны — назначения, куда клиент ноды не имеет
 * права ходить. Без этого правила дефолтный freedom выпускает клиента на 127.0.0.1:10085,
 * то есть в локальный gRPC API Xray (HandlerService/StatsService) без всякой аутентификации:
 * можно завести себе пользователя на ноде и перечислить чужие email (=shortUuid).
 */
const PRIVATE_DESTINATIONS = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

/**
 * Транспорт-специфичный блок streamSettings по network. tcp — пусто (нет settings).
 * Для grpc/ws/xhttp Xray требует свой блок, иначе транспорт молча не поднимается.
 */
function transportSettings(inbound: NodeInbound): Record<string, unknown> | null {
  switch (inbound.network) {
    case "grpc":
      return { grpcSettings: { serviceName: inbound.serviceName ?? "" } };
    case "ws":
      return { wsSettings: { path: inbound.path ?? "/", ...(inbound.host ? { headers: { Host: inbound.host } } : {}) } };
    case "xhttp":
      return { xhttpSettings: { path: inbound.path ?? "/", ...(inbound.host ? { host: inbound.host } : {}) } };
    default:
      return null; // tcp
  }
}

/**
 * Слой безопасности inbound'а. reality — self-handshake (серт не нужен, приватник на ноде).
 * tls — реальный серт на ноде (вариант B, подставляет агент). none — TLS терминирует CDN
 * перед нодой (вариант A), на ноде транспорт без шифрования.
 *
 * ВАЖНО: для reality вывод сохранён байт-в-байт (тот же порядок/поля), иначе сменится
 * config_hash и все ноды перезальются, а golden-diff разъедется.
 */
function securitySettings(inbound: NodeInbound): Record<string, unknown> {
  const security = inbound.security ?? "reality";
  if (security === "reality") {
    return {
      security: "reality",
      realitySettings: {
        show: false,
        dest: `${inbound.reality.sni}:443`,
        serverNames: [inbound.reality.sni],
        privateKey: "__REALITY_PRIVATE_KEY__", // подставляется агентом на ноде из локального ключа
        shortIds: [...inbound.reality.shortIds].sort(),
      },
    };
  }
  if (security === "tls") {
    return {
      security: "tls",
      tlsSettings: {
        serverName: inbound.reality.sni,
        alpn: inbound.network === "grpc" ? ["h2"] : ["h2", "http/1.1"],
        // подставляет агент из локальных файлов (вариант B); плейсхолдеры по образцу reality
        certificates: [{ certificateFile: "__TLS_CERT__", keyFile: "__TLS_KEY__" }],
      },
    };
  }
  return { security: "none" };
}

function buildInbound(inbound: NodeInbound, users: NodeUser[]): Record<string, unknown> {
  const clients = users
    .filter((u) => u.inboundTag === inbound.tag)
    .map((u) => ({ id: u.uuid, email: u.email, level: u.level ?? 0, flow: inbound.flow ?? "" }))
    .sort((a, b) => a.email.localeCompare(b.email)); // стабильный порядок → стабильный hash

  const streamSettings: Record<string, unknown> = {
    network: inbound.network ?? "tcp",
    ...securitySettings(inbound),
    ...(transportSettings(inbound) ?? {}),
  };

  return {
    tag: inbound.tag,
    listen: "0.0.0.0",
    port: inbound.port,
    protocol: "vless",
    settings: {
      // пустой clients ломает AlterInbound («proxy is not a UserManager») — держим хотя бы пустой массив осознанно
      clients,
      decryption: "none",
    },
    streamSettings,
    sniffing: {
      enabled: true,
      destOverride: ["http", "tls", "quic"],
      // routeOnly обязателен: иначе ломается direct-матч по IP и рвётся Reality/Vision
      routeOnly: true,
    },
  };
}

function cascadeOutbound(c: CascadeOutbound): Record<string, unknown> {
  return {
    tag: c.tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: c.exit.address,
          port: c.exit.port,
          users: [{ id: c.exit.uuid, encryption: "none", flow: c.exit.flow }],
        },
      ],
    },
    streamSettings: {
      network: "tcp",
      security: "reality",
      realitySettings: {
        serverName: c.exit.reality.sni,
        fingerprint: c.exit.reality.fingerprint,
        publicKey: c.exit.reality.publicKey,
        shortId: c.exit.reality.shortIds[0] ?? "",
      },
    },
  };
}

/**
 * Конфиг НОДЫ (не клиента). Детерминирован: одинаковый вход → одинаковый config_hash →
 * агент видит совпадение и делает no-op. Поэтому все списки сортируются.
 */
export function buildNodeConfig(input: NodeConfigInput): XrayConfig {
  const inbounds: Array<Record<string, unknown>> = [...input.inbounds]
    .sort((a, b) => a.tag.localeCompare(b.tag))
    .map((i) => buildInbound(i, input.users));

  // локальный gRPC API — через него агент снимает статистику
  inbounds.push({
    tag: API_TAG,
    listen: "127.0.0.1",
    port: API_PORT,
    protocol: "dokodemo-door",
    settings: { address: "127.0.0.1" },
  });

  const outbounds: Array<Record<string, unknown>> = [
    { tag: "freedom", protocol: "freedom", settings: {} },
    { tag: "block", protocol: "blackhole", settings: {} },
  ];
  for (const c of [...(input.cascades ?? [])].sort((a, b) => a.tag.localeCompare(b.tag))) {
    outbounds.push(cascadeOutbound(c));
  }

  const rules: Array<Record<string, unknown>> = [
    // ПЕРВЫМ и только первым: следующее правило режет 127/8, а сам api-инбаунд ходит
    // на 127.0.0.1 — переставь местами, и агент перестанет снимать статистику
    { type: "field", inboundTag: [API_TAG], outboundTag: API_TAG },
    { type: "field", ip: PRIVATE_DESTINATIONS, outboundTag: "block" },
    // анти-абьюз дешёвым конфигом: торренты и спам режем на всех ролях
    { type: "field", protocol: ["bittorrent"], outboundTag: "block" },
  ];
  if (input.blockOutboundSmtp !== false) {
    rules.push({ type: "field", port: "25", outboundTag: "block" });
  }
  // server-forward: весь трафик с relay-inbound уходит в конкретный exit
  for (const c of [...(input.cascades ?? [])].sort((a, b) => a.tag.localeCompare(b.tag))) {
    rules.push({ type: "field", inboundTag: [c.fromInboundTag], outboundTag: c.tag });
  }

  return {
    log: { loglevel: input.logLevel ?? "warning" },
    api: { tag: API_TAG, services: ["HandlerService", "StatsService", "LoggerService"] },
    stats: {},
    policy: {
      levels: { "0": { statsUserUplink: true, statsUserDownlink: true } },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true,
      },
    },
    inbounds,
    outbounds,
    routing: { domainStrategy: "AsIs", rules },
  };
}

/** Канонизация: сортировка ключей, чтобы hash не зависел от порядка полей. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function configHash(config: XrayConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/**
 * Детерминированный uuid v5 для link-user каскада.
 * Рандом здесь недопустим: при повторной раскатке появился бы второй служебный
 * пользователь, а первый остался бы висеть на exit'е.
 */
export function deterministicUuid(namespace: string, name: string): string {
  const hash = createHash("sha1").update(`${namespace}:${name}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // версия 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
