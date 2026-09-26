import type { RateLimitRule } from "./common/rate-limit.service.js";

export interface CoreConfig {
  instanceType: "api" | "worker";
  port: number;
  /**
   * Git-ревизия, из которой собран образ. Отдаётся в /healthz: деплой сверяет её
   * с выкатываемой и так ловит «compose вернул 0, но контейнер не пересоздался».
   */
  appVersion: string;
  defaultOrgId: string;
  subPublicHost: string;
  profileUpdateIntervalHours: number;
  supportUrl: string;
  announce: string;
  /** Название подписки в клиенте. Кириллица уедет в base64-заголовок. */
  profileTitle: string;
  /** Лимит выдачи подписки на один short_uuid — расшаренная ссылка не должна долбить генератор. */
  subRateLimitPerSub: RateLimitRule;
  /** Лимит выдачи на один IP. Заметно шире: за общим NAT сидит много честных клиентов. */
  subRateLimitPerIp: RateLimitRule;
  /** Откуда брать адрес клиента: true — правый (ближайший к нам) хоп x-forwarded-for, false — socket-адрес. */
  subRateLimitTrustProxy: boolean;
  /** Окно «живого» устройства: не виденные дольше — не занимают слот hwid-лимита. */
  hwidActiveWindowDays: number;
  /** Перебор пароля оператора: жёстко по IP. */
  adminLoginRateLimitPerIp: RateLimitRule;
  /** Тот же перебор, но по email: смена IP не должна обнулять счётчик по учётке. */
  adminLoginRateLimitPerEmail: RateLimitRule;
  /** Остальной админский API по IP. Мягко: это рабочий инструмент, а не публичная точка. */
  adminRateLimitPerIp: RateLimitRule;
  /** Вебхуки провайдеров по IP. С запасом: провайдер догоняет очередь пачкой. */
  webhookRateLimitPerIp: RateLimitRule;
  /** Служебные вызовы (бот, воркеры, node-agent) по IP. */
  internalRateLimitPerIp: RateLimitRule;
  /** Ключ шифрования кредов мерчантов. В БД креды лежат только зашифрованными. */
  secretsMasterKey: string;
  /** Внешний URL API — из него строятся callback_url для платёжных вебхуков. */
  publicApiUrl: string;
  paymentSuccessUrl: string;
  paymentFailUrl: string;
  /** Внутренний URL бота — через него уходят рассылки и ответы поддержки в Telegram. */
  botInternalUrl: string;
  /** Общий секрет core↔бот, заголовок x-service-token. Пустой = /internal/* закрыт наглухо. */
  serviceToken: string;
  /** Секрет админского API, заголовок x-admin-token. Пустой = /api/admin/* закрыт наглухо. */
  adminToken: string;
  /**
   * ПЕРЕХОДНЫЙ общий секрет node-agent↔core, заголовок x-agent-token.
   * Принимается только от нод, которые ещё не прошли энроллмент: у прошедшей
   * ноды действует её собственный токен (node_identity.agent_token_hash).
   */
  agentToken: string;
  /** Срок жизни невостребованного bootstrap-токена ноды, часы. 0 = без срока. */
  nodeBootstrapTtlHours: number;
  /**
   * Приватный RSA-ключ (PEM) для подписи desired-state. Пусто — desired-state
   * уходит голым JSON (переходный режим, см. docs/security.md).
   */
  desiredStateSigningKey: string;
  /** Redis под очереди BullMQ. Пусто — очередей нет, джобы гоняются только руками. */
  redisUrl: string;
  /** Действующая панель Remnawave — читаем при миграции. Только чтение. */
  remnawaveUrl: string;
  remnawaveToken: string;
  /** Детектор по трафику: нода оценивается от стольких активных клиентов, обычных для этого часа. */
  trafficDetectMinUsers: number;
  /** Детектор по трафику: падение активных клиентов против обычного, %, после которого «пропали». 0 — выключен. */
  trafficDetectDropPct: number;
}

export function loadConfig(): CoreConfig {
  return {
    instanceType: (process.env.INSTANCE_TYPE as "api" | "worker") ?? "api",
    port: Number(process.env.CORE_PORT ?? 3100),
    appVersion: process.env.APP_VERSION ?? "dev",
    defaultOrgId: process.env.DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000001",
    subPublicHost: process.env.SUB_PUBLIC_HOST ?? "panel.gavy.shop",
    profileUpdateIntervalHours: Number(process.env.SUB_PROFILE_UPDATE_INTERVAL ?? 12),
    supportUrl: process.env.SUB_SUPPORT_URL ?? "",
    announce: process.env.SUB_ANNOUNCE ?? "",
    profileTitle: process.env.SUB_PROFILE_TITLE ?? "VPN",
    subRateLimitPerSub: {
      limit: intEnv(process.env.SUB_RATE_LIMIT_PER_SUB, 30),
      windowSec: intEnv(process.env.SUB_RATE_LIMIT_WINDOW_SEC, 600),
    },
    subRateLimitPerIp: {
      limit: intEnv(process.env.SUB_RATE_LIMIT_PER_IP, 300),
      windowSec: intEnv(process.env.SUB_RATE_LIMIT_WINDOW_SEC, 600),
    },
    subRateLimitTrustProxy: (process.env.SUB_RATE_LIMIT_TRUST_PROXY ?? "true") !== "false",
    hwidActiveWindowDays: intEnv(process.env.SUB_HWID_ACTIVE_DAYS, 30),
    adminLoginRateLimitPerIp: {
      limit: intEnv(process.env.ADMIN_LOGIN_RATE_LIMIT_PER_IP, 10),
      windowSec: intEnv(process.env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_SEC, 900),
    },
    adminLoginRateLimitPerEmail: {
      limit: intEnv(process.env.ADMIN_LOGIN_RATE_LIMIT_PER_EMAIL, 5),
      windowSec: intEnv(process.env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_SEC, 900),
    },
    adminRateLimitPerIp: {
      limit: intEnv(process.env.ADMIN_RATE_LIMIT_PER_IP, 300),
      windowSec: intEnv(process.env.ADMIN_RATE_LIMIT_WINDOW_SEC, 60),
    },
    webhookRateLimitPerIp: {
      limit: intEnv(process.env.WEBHOOK_RATE_LIMIT_PER_IP, 600),
      windowSec: intEnv(process.env.WEBHOOK_RATE_LIMIT_WINDOW_SEC, 60),
    },
    internalRateLimitPerIp: {
      limit: intEnv(process.env.INTERNAL_RATE_LIMIT_PER_IP, 1200),
      windowSec: intEnv(process.env.INTERNAL_RATE_LIMIT_WINDOW_SEC, 60),
    },
    secretsMasterKey: process.env.SECRETS_MASTER_KEY ?? "",
    publicApiUrl: (process.env.PUBLIC_API_URL ?? "http://localhost:3100").replace(/\/+$/, ""),
    paymentSuccessUrl: process.env.PAYMENT_SUCCESS_URL ?? "",
    paymentFailUrl: process.env.PAYMENT_FAIL_URL ?? "",
    botInternalUrl: (process.env.BOT_INTERNAL_URL ?? "http://localhost:3300").replace(/\/+$/, ""),
    serviceToken: process.env.SERVICE_TOKEN ?? "",
    adminToken: process.env.ADMIN_TOKEN ?? "",
    agentToken: process.env.AGENT_TOKEN ?? "",
    nodeBootstrapTtlHours: intEnv(process.env.NODE_BOOTSTRAP_TTL_HOURS, 24),
    // PEM в env неизбежно приезжает с экранированными переносами — разворачиваем,
    // иначе createPrivateKey ругается на «неправильный» ключ, который на вид верный.
    desiredStateSigningKey: (process.env.DESIRED_STATE_SIGNING_KEY ?? "").replace(/\\n/g, "\n"),
    redisUrl: process.env.REDIS_URL ?? "",
    remnawaveUrl: (process.env.REMNAWAVE_URL ?? "").replace(/\/+$/, ""),
    remnawaveToken: process.env.REMNAWAVE_TOKEN ?? "",
    trafficDetectMinUsers: intEnv(process.env.TRAFFIC_DETECT_MIN_USERS, 10),
    trafficDetectDropPct: Math.min(intEnv(process.env.TRAFFIC_DETECT_DROP_PCT, 70), 99),
  };
}

/**
 * Целое из env. Ноль допустим — им лимит выключается без выкатки кода.
 * Мусор и отрицательные значения уходят в дефолт: Number("abc") дал бы NaN,
 * а сравнение с NaN всегда ложно, то есть лимит молча перестал бы действовать.
 */
function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
