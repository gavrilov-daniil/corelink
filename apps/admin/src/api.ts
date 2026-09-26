export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? e.message : `${e.status}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

const TOKEN_STORAGE_KEY = "vpn-admin-token";

/** Токен админского API (заголовок x-admin-token): сессия оператора или переходный ADMIN_TOKEN. */
export function getAdminToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

export function setAdminToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
}

export function clearAdminToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getAdminToken();
  if (token) headers.set("x-admin-token", token);

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "сеть недоступна или сервер не отвечает");
  }

  if (!res.ok) throw new ApiError(res.status, await readError(res));

  const text = await res.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (text.length === 0) return res.statusText;
  try {
    const body = JSON.parse(text) as { message?: string | string[]; error?: string };
    if (Array.isArray(body.message)) return body.message.join("; ");
    return body.message ?? body.error ?? text;
  } catch {
    return text.slice(0, 300);
  }
}

const post = (body?: unknown): RequestInit =>
  body === undefined
    ? { method: "POST" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };

const patch = (body: unknown): RequestInit => ({ ...post(body), method: "PATCH" });

const put = (body: unknown): RequestInit => ({ ...post(body), method: "PUT" });

const del = (): RequestInit => ({ method: "DELETE" });

// --- Вход, операторы, роли --------------------------------------------------

export const ADMIN_ROLES = ["support", "admin", "superadmin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ROLE_LABELS: Record<AdminRole, string> = {
  support: "Саппорт",
  admin: "Админ",
  superadmin: "Супер-админ",
};

export const ROLE_HINTS: Record<AdminRole, string> = {
  support: "Переписка с клиентами и просмотр их подписок",
  admin: "Всё, кроме платёжных провайдеров",
  superadmin: "Всё, включая ключи платёжных провайдеров",
};

/** Копия порога из core: кнопка не должна быть активной ради 400 в ответ. */
export const MIN_PASSWORD_LENGTH = 10;

export interface Me {
  operatorId: string | null;
  email: string | null;
  displayName: string | null;
  role: AdminRole;
  telegramUsername: string | null;
  hasPassword: boolean;
  hasTelegram: boolean;
  /** Вход по переходному ADMIN_TOKEN: учётки за ним нет, свой профиль недоступен. */
  viaSharedToken: boolean;
}

export interface Operator {
  id: string;
  email: string | null;
  displayName: string | null;
  telegramId: number | null;
  telegramUsername: string | null;
  role: AdminRole;
  status: "pending" | "active" | "disabled";
  hasPassword: boolean;
  approvedAt: string | null;
  createdAt: string;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  operator: { id: string; email: string | null; role: AdminRole; displayName: string | null };
}

/**
 * Результат входа через Telegram, забранный по одноразовому билету.
 * Заявка (`pending`) сессии не даёт: доступа нет, пока админ не подтвердит.
 * `linked` возвращается, когда тем же флоу привязывали Telegram к своей учётке.
 */
export type TelegramLoginResult =
  | { status: "pending" }
  | { status: "linked"; telegramId: number; telegramUsername: string | null }
  | ({ status: "ok" } & LoginResult);

export interface TelegramSettings {
  isEnabled: boolean;
  botUsername: string;
  clientId: string;
  redirectUri: string;
  /** Сам секрет наружу не отдаётся — только признак, что он задан. */
  hasClientSecret: boolean;
  updatedAt: string | null;
}

export const loginWithPassword = (email: string, password: string) =>
  request<LoginResult>("/api/admin/auth/login", post({ email, password }));

/** Ссылка на экран Telegram. Заодно сервер ставит куку, связывающую вход с браузером. */
export const startTelegramLogin = () => request<{ url: string }>("/api/admin/auth/telegram/start", post());

/** Тот же флоу, но для привязки Telegram к уже открытой учётке. */
export const startTelegramLink = () => request<{ url: string }>("/api/admin/auth/telegram/link/start", post());

export const exchangeTelegramTicket = (ticket: string) =>
  request<TelegramLoginResult>("/api/admin/auth/telegram/exchange", post({ ticket }));

export const getTelegramLoginConfig = () => request<{ enabled: boolean }>("/api/admin/auth/telegram/config");

export const getMe = () => request<Me>("/api/admin/auth/me");

export const logout = () => request<{ ok: boolean }>("/api/admin/auth/logout", post());

export const changeOwnPassword = (password: string) =>
  request<{ ok: boolean }>("/api/admin/auth/password", post({ password }));

export const unlinkOwnTelegram = () => request<{ ok: boolean }>("/api/admin/auth/telegram/link", del());

export const getOperators = () => request<Operator[]>("/api/admin/auth/operators");

export const createOperator = (body: {
  email: string;
  password: string;
  role: AdminRole;
  displayName?: string;
}) => request<{ id: string; email: string; role: AdminRole }>("/api/admin/auth/operators", post(body));

export const approveOperator = (id: string, role: AdminRole) =>
  request<{ ok: boolean }>(`/api/admin/auth/operators/${id}/approve`, post({ role }));

/** Роль и доступ меняются одной ручкой: на сервере это одна запись, а не две. */
export const updateOperator = (id: string, body: { role?: AdminRole; status?: "active" | "disabled" }) =>
  request<{ ok: boolean }>(`/api/admin/auth/operators/${id}`, patch(body));

export const setOperatorPassword = (id: string, password: string) =>
  request<{ ok: boolean }>(`/api/admin/auth/operators/${id}/password`, post({ password }));

export const unlinkOperatorTelegram = (id: string) =>
  request<{ ok: boolean }>(`/api/admin/auth/operators/${id}/telegram`, del());

export const getTelegramSettings = () => request<TelegramSettings>("/api/admin/auth/telegram/settings");

export const updateTelegramSettings = (body: {
  isEnabled?: boolean;
  botUsername?: string;
  clientId?: string;
  redirectUri?: string;
  /** Не передан — не трогаем; пустая строка — стираем. */
  clientSecret?: string;
}) => request<TelegramSettings>("/api/admin/auth/telegram/settings", patch(body));

// --- Мерчанты ---------------------------------------------------------------

export interface Merchant {
  id: string;
  orgId: string;
  provider: string;
  alias: string;
  isEnabled: boolean;
  mode: "live" | "test";
  priority: number;
  /** С бэкенда приходят маскированными («••••••••»), значим только набор ключей. */
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
  purposes: string[];
  title: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  createdAt: string;
  updatedAt: string;
  isConfigured: boolean;
}

export interface ProviderSpec {
  provider: string;
  title: string;
  credentialFields: { key: string; label: string; required: boolean }[];
  settingFields: { key: string; label: string; type: "number" | "string"; default?: string | number }[];
  purposes: string[];
}

export const getMerchants = () => request<Merchant[]>("/api/admin/merchants");

export const getProviderSpecs = () => request<ProviderSpec[]>("/api/admin/merchants/provider-specs");

export const createMerchant = (body: {
  provider: string;
  alias: string;
  title?: string;
  mode?: "live" | "test";
  credentials?: Record<string, string>;
  settings?: Record<string, unknown>;
  purposes?: string[];
}) => request<Merchant>("/api/admin/merchants", post(body));

export const updateMerchant = (
  id: string,
  body: {
    alias?: string;
    title?: string;
    isEnabled?: boolean;
    mode?: "live" | "test";
    priority?: number;
    purposes?: string[];
    settings?: Record<string, unknown>;
    /** Передаются только изменяемые ключи; пустая строка удаляет ключ. */
    credentials?: Record<string, string>;
  },
) => request<Merchant>(`/api/admin/merchants/${id}`, patch(body));

export const checkMerchant = (id: string) =>
  request<{ ok: boolean; detail?: string }>(`/api/admin/merchants/${id}/check`, post());

// --- Ноды и каскады ---------------------------------------------------------

export const NODE_ROLES = ["exit", "relay", "front"] as const;
export const NODE_STATUSES = ["provisioning", "active", "disabled", "retiring"] as const;

export interface Node {
  id: string;
  name: string;
  roles: string[];
  status: string;
  serverId: string;
  serverHostname: string | null;
  configProfileId: string;
  consumptionMultiplier: number;
  trackTraffic: boolean;
  sortOrder: number;
  address: string | null;
  country: string | null;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  xrayVersion: string | null;
  desiredVersion: number | null;
  desiredConfigHash: string | null;
  appliedConfigHash: string | null;
  /** desired-хеш совпал с применённым агентом — только это значит «конфиг доехал». */
  converged: boolean;
}

/** Что пересобралось после правки: без этого не видно, доехало ли изменение до нод. */
export interface RebuildInfo {
  nodeId: string;
  name: string;
  version: number;
  changed: boolean;
}

export interface NodeInput {
  serverId: string;
  configProfileId: string;
  name: string;
  roles: string[];
  status?: string;
  consumptionMultiplier?: number;
  trackTraffic?: boolean;
  sortOrder?: number;
}

export const createNode = (body: NodeInput) =>
  request<Node & { rebuilt: RebuildInfo[] }>("/api/admin/nodes", post(body));

export const updateNode = (id: string, body: Partial<NodeInput>) =>
  request<Node & { rebuilt: RebuildInfo[] }>(`/api/admin/nodes/${id}`, patch(body));

export const deleteNode = (id: string) => request<{ ok: boolean }>(`/api/admin/nodes/${id}`, del());

/** Значение показывается ЕДИНСТВЕННЫЙ раз: в БД лежит только его хеш. */
export const issueEnrollment = (id: string) =>
  request<{ nodeId: string; nodeName: string; bootstrapToken: string; bootstrapExpiresAt: string | null }>(
    `/api/admin/nodes/${id}/enrollment`,
    post(),
  );

export interface DesiredState {
  nodeId: string;
  version: number;
  configHash: string;
  config: Record<string, unknown> & { inbounds?: { tag?: string; port?: number; protocol?: string }[] };
  users: { email: string; uuid: string; level: number }[];
  generatedAt: string;
}

export interface Cascade {
  id: string;
  orgId: string;
  kind: "server_forward" | "client_chain";
  cc: string;
  relayNodeId: string | null;
  frontNodeId: string | null;
  exitNodeId: string;
  exitInboundTag: string;
  linkUserUuid: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const getNodes = () => request<Node[]>("/api/admin/nodes");

export const getDesiredState = (nodeId: string) =>
  request<DesiredState>(`/api/admin/nodes/${nodeId}/desired-state`);

export const rebuildNode = (nodeId: string) =>
  request<{ changed: boolean; version: number; hash: string }>(`/api/admin/nodes/${nodeId}/rebuild`, post());

export const getCascades = () => request<Cascade[]>("/api/admin/cascades");

export const createCascade = (body: {
  kind: "server_forward" | "client_chain";
  cc: string;
  exitNodeId: string;
  exitInboundTag: string;
  relayNodeId?: string;
  frontNodeId?: string;
}) => request<Cascade | null>("/api/admin/cascades", post(body));

export const refreshCascade = (id: string) =>
  request<Cascade | null>(`/api/admin/cascades/${id}/refresh`, post());

// --- Инфраструктура: серверы, профили, inbound'ы, host'ы, squad'ы ------------

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
export const INBOUND_NETWORKS = ["tcp", "grpc", "xhttp", "ws"] as const;
export const INBOUND_FLOWS = ["xtls-rprx-vision", ""] as const;

export type SshAuthType = "password" | "key" | "vault_ref";

export interface Server {
  id: string;
  hostname: string;
  primaryIp: string;
  extraIps: string[];
  country: string | null;
  capabilities: Record<string, unknown>;
  agentStatus: string;
  agentVersion: string | null;
  xrayVersion: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  sshAuthType: SshAuthType;
  sshUser: string | null;
  sshPort: number | null;
  /** ssh_ref — указатель в vault; наружу отдаётся только признак, что он задан. */
  hasSshRef: boolean;
  /** Пароль/ключ лежат в БД зашифрованными; наружу — только признак «задан». */
  hasSshSecret: boolean;
  sshLastCheckAt: string | null;
  sshLastCheckOk: boolean | null;
  sshLastCheckError: string | null;
  nodeCount: number;
}

export interface ConfigProfile {
  id: string;
  name: string;
  baseJson: Record<string, unknown>;
  createdAt: string;
  nodeId: string | null;
  nodeName: string | null;
  inboundCount: number;
}

export interface Inbound {
  id: string;
  configProfileId: string;
  tag: string;
  protocol: string;
  network: string;
  security: string;
  port: number;
  flow: string;
  sni: string | null;
  fingerprint: string | null;
  realityPublicKey: string | null;
  shortIds: string[];
  params: Record<string, unknown>;
  hasRealityPrivkeyRef: boolean;
  nodeId: string | null;
  nodeName: string | null;
}

export interface Host {
  id: string;
  inboundId: string;
  nodeId: string;
  remark: string;
  address: string;
  port: number;
  sni: string | null;
  fingerprint: string | null;
  alpn: string | null;
  pbk: string | null;
  sid: string | null;
  flow: string | null;
  tagPrefix: string | null;
  isHidden: boolean;
  isDisabled: boolean;
  sortOrder: number;
  inboundTag: string | null;
  nodeName: string | null;
  channelCount: number;
}

export interface Squad {
  id: string;
  name: string;
  /** Общий squad: в нём каждая подписка автоматически, без тарифа. Один на org. */
  forAll: boolean;
  inbounds: { id: string; tag: string }[];
  /** Подписок с явным членством (у общего — обычно 0: членство подразумевается). */
  subscriptionCount: number;
  /** Тарифы, которые выдают squad при оплате. */
  plans: { code: string; title: string }[];
}

type WithRebuild<T> = T & { rebuilt: RebuildInfo[] };

export const getServers = () => request<Server[]>("/api/admin/servers");

export const createServer = (body: {
  hostname: string;
  primaryIp: string;
  extraIps?: string[];
  country?: string | null;
  sshAuthType?: SshAuthType;
  sshUser?: string | null;
  sshPort?: number | null;
  sshRef?: string | null;
  /** Секреты; наружу не возвращаются. Пустая строка при правке = очистить ключ. */
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
  capabilities?: Record<string, unknown>;
}) => request<Server>("/api/admin/servers", post(body));

export const updateServer = (id: string, body: Partial<Parameters<typeof createServer>[0]>) =>
  request<Server>(`/api/admin/servers/${id}`, patch(body));

export const deleteServer = (id: string) => request<{ ok: boolean }>(`/api/admin/servers/${id}`, del());

export const checkServerSsh = (id: string) =>
  request<{ ok: boolean; detail: string }>(`/api/admin/servers/${id}/ssh-check`, post());

export const getConfigProfiles = () => request<ConfigProfile[]>("/api/admin/config-profiles");

export const createConfigProfile = (body: { name: string; baseJson?: Record<string, unknown> }) =>
  request<ConfigProfile>("/api/admin/config-profiles", post(body));

export const updateConfigProfile = (id: string, body: { name?: string; baseJson?: Record<string, unknown> }) =>
  request<WithRebuild<ConfigProfile>>(`/api/admin/config-profiles/${id}`, patch(body));

export const deleteConfigProfile = (id: string) =>
  request<{ ok: boolean }>(`/api/admin/config-profiles/${id}`, del());

export interface InboundInput {
  configProfileId: string;
  tag: string;
  port: number;
  network?: string;
  flow?: string;
  sni?: string | null;
  fingerprint?: string;
  shortIds?: string[];
  realityPrivkeyRef?: string | null;
}

export const getInbounds = () => request<Inbound[]>("/api/admin/inbounds");

export const createInbound = (body: InboundInput) =>
  request<WithRebuild<Inbound>>("/api/admin/inbounds", post(body));

export const updateInbound = (id: string, body: Partial<Omit<InboundInput, "configProfileId">>) =>
  request<WithRebuild<Inbound>>(`/api/admin/inbounds/${id}`, patch(body));

export const deleteInbound = (id: string) =>
  request<{ ok: boolean; rebuilt: RebuildInfo[] }>(`/api/admin/inbounds/${id}`, del());

export interface HostInput {
  inboundId: string;
  nodeId: string;
  remark: string;
  address: string;
  port: number;
  sni?: string | null;
  fingerprint?: string;
  alpn?: string | null;
  pbk?: string | null;
  sid?: string | null;
  flow?: string;
  tagPrefix?: string | null;
  isHidden?: boolean;
  isDisabled?: boolean;
  sortOrder?: number;
}

export const getHosts = () => request<Host[]>("/api/admin/hosts");

export const createHost = (body: HostInput) => request<WithRebuild<Host>>("/api/admin/hosts", post(body));

export const updateHost = (id: string, body: Partial<HostInput>) =>
  request<WithRebuild<Host>>(`/api/admin/hosts/${id}`, patch(body));

export const deleteHost = (id: string) =>
  request<{ ok: boolean; rebuilt: RebuildInfo[] }>(`/api/admin/hosts/${id}`, del());

export const getSquads = () => request<Squad[]>("/api/admin/squads");

/** Состав: inboundIds (продвинутый режим) или nodeIds (простой — локациями), не оба сразу. */
type SquadBody = { name?: string; inboundIds?: string[]; nodeIds?: string[] };

export const createSquad = (body: SquadBody & { name: string }) =>
  request<WithRebuild<Squad>>("/api/admin/squads", post(body));

/** Состав — полная замена, а не добавление. */
export const updateSquad = (id: string, body: SquadBody) =>
  request<WithRebuild<Squad>>(`/api/admin/squads/${id}`, patch(body));

/** Общий squad: до первой локации его нет, поэтому правка без id — сервер заведёт его сам. */
export const updateGeneralSquad = (body: SquadBody) =>
  request<WithRebuild<Squad>>("/api/admin/squads/general", put(body));

export const deleteSquad = (id: string) =>
  request<{ ok: boolean; rebuilt: RebuildInfo[] }>(`/api/admin/squads/${id}`, del());

// --- Мастер «Добавить локацию» ----------------------------------------------
// Одна ручка заводит всю цепочку сервер→профиль→нода→inbound→host и привязывает
// inbound к squad'ам. Идемпотентна по натуральным ключам: повторный прогон с теми
// же данными ничего не дублирует.

/** Одна созданная (или переиспользованная) сущность цепочки. */
export interface ProvisionedRef {
  id: string;
  label: string;
  /** true — строку завёл этот вызов; false — уже была и переиспользована. */
  created: boolean;
}

export interface ProvisionResult {
  server: ProvisionedRef;
  configProfile: ProvisionedRef;
  node: ProvisionedRef;
  inbound: ProvisionedRef;
  host: ProvisionedRef;
  /** Squad'ы, открывающие локацию клиентам, включая общий (forAll). */
  squads: { id: string; name: string; forAll: boolean; attached: boolean }[];
  /** Куда локация попала в выдаче; null — не выходная нода (relay/front). */
  delivery: { channelTag: string; tier: number; profiles: string[] } | null;
  rebuilt: RebuildInfo[];
}

export interface ProvisionInput {
  /** Имя локации: станет именем ноды, профиля и основой тега inbound'а. */
  name: string;
  primaryIp: string;
  /** Домен-маскировка Reality (обязателен). */
  sni: string;
  country?: string | null;
  port?: number;
  /** По умолчанию = primaryIp. */
  hostname?: string;
  /** По умолчанию VLESS_REALITY_<ИМЯ>. */
  tag?: string;
  /** По умолчанию ["exit"]. */
  roles?: string[];
  fingerprint?: string;
  /** В какие свои squad'ы добавить inbound (доступ подписок по тарифу). */
  squadIds?: string[];
  /** Открыть локацию всем клиентам через общий squad (по умолчанию — да). */
  inGeneral?: boolean;
  /** Формат подключения. reality (default) | tls | none (CDN терминирует TLS). */
  security?: string;
  /** tcp (default) | grpc | ws | xhttp. */
  network?: string;
  /** Пусто для reality; для CDN — "" (vision только на tcp). */
  flow?: string;
  /** Транспорт CDN: { serviceName } для grpc, { path, host } для ws/xhttp. */
  params?: Record<string, unknown>;
  /** Адрес, куда стучится клиент (для CDN — CDN-домен; по умолчанию = primaryIp). */
  hostAddress?: string;
  /** Эшелон в подписке: 1 основной, 2 резерв, 3 последний резерв. По умолчанию 1. */
  tier?: number;
  /** Класть ли локацию в «🔀 Авто» и в профиль страны (по умолчанию — да; false = исключить). */
  inAuto?: boolean;
  inCountry?: boolean;
  /** SSH-доступ к серверу для последующей авто-настройки; секреты шифруются в БД, наружу не отдаются. */
  sshAuthType?: SshAuthType;
  sshUser?: string | null;
  sshPort?: number | null;
  sshRef?: string | null;
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
}

export const provisionLocation = (body: ProvisionInput) =>
  request<ProvisionResult>("/api/admin/infra/provision", post(body));

/** Каскадное удаление локации: сервер + нода(ы) со всей цепочкой. Отвергается, если локация в работе. */
export const deleteLocation = (serverId: string) =>
  request<{ ok: boolean; removedNodes: number }>(`/api/admin/infra/locations/${serverId}`, del());

/** Выдача локации клиентам: эшелон и членство в «Авто»/профиле страны. */
export interface LocationDelivery {
  nodeId: string;
  /** Канал локации заведён (у локаций, созданных до авто-выдачи, может не быть). */
  wired: boolean;
  tier: number | null;
  inAuto: boolean;
  inCountry: boolean;
  countryProfile: string | null;
}

export const getLocationDelivery = () => request<LocationDelivery[]>("/api/admin/infra/locations/delivery");

/**
 * Выдача и доступ локации. inGeneral / squadIds необязательны: без них squad'ы не трогаются.
 * squadIds — полный набор своих squad'ов локации (снятая галочка убирает её из squad'а).
 */
export const setLocationDelivery = (
  serverId: string,
  body: { tier: number; inAuto: boolean; inCountry: boolean; inGeneral?: boolean; squadIds?: string[] },
) =>
  request<{ channelTag: string; tier: number; profiles: string[]; rebuilt: RebuildInfo[] }>(
    `/api/admin/infra/locations/${serverId}/delivery`,
    put(body),
  );

// --- авто-настройка сервера по SSH ------------------------------------------

export interface ProvisionRun {
  id: string;
  serverId: string;
  nodeId: string | null;
  kind: string;
  status: "queued" | "running" | "success" | "failed";
  log: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export const provisionServer = (id: string) =>
  request<{ runId: string; already: boolean }>(`/api/admin/servers/${id}/provision`, post());

export const reprovisionServer = (id: string) =>
  request<{ runId: string; already: boolean }>(`/api/admin/servers/${id}/reprovision`, post());

export const getProvisionRun = (id: string) => request<ProvisionRun>(`/api/admin/provision-runs/${id}`);

export const listProvisionRuns = (serverId: string) =>
  request<ProvisionRun[]>(`/api/admin/servers/${serverId}/provision-runs`);

// --- Подписчики -------------------------------------------------------------

export interface Subscriber {
  /** id подписки, не подписчика. */
  id: string;
  subscriberId: string;
  shortUuid: string;
  subscriptionUrl: string;
  username: string | null;
  telegramId: number | null;
  /** Метка человека без бота (ручная выдача). */
  label: string | null;
  status: string;
  expireAt: string | null;
  usedTrafficBytes: number;
  /** null — без лимита. */
  trafficLimitBytes: number | null;
  /** null — без лимита. */
  deviceLimit: number | null;
  devicesUsed: number;
}

export interface UsageRow {
  nodeId: string;
  day: string;
  up: number;
  down: number;
}

export interface SubscriberDevice {
  hwid: string;
  deviceOs: string | null;
  deviceModel: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface RevokeResult {
  shortUuid: string;
  subscriptionUrl: string;
  nodesChanged?: number;
  nodesFailed?: number;
}

export const getSubscribers = () => request<Subscriber[]>("/api/admin/subscribers");

export const getUsage = (shortUuid: string) =>
  request<UsageRow[]>(`/api/admin/usage/${encodeURIComponent(shortUuid)}`);

export const getDevices = (subscriptionId: string) =>
  request<SubscriberDevice[]>(`/api/admin/subscriptions/${subscriptionId}/devices`);

/** hwid обязателен к энкодингу: там бывает что угодно, включая слеши. */
export const unlinkDevice = (subscriptionId: string, hwid: string) =>
  request<{ ok: boolean; removed: number }>(
    `/api/admin/subscriptions/${subscriptionId}/devices/${encodeURIComponent(hwid)}`,
    { method: "DELETE" },
  );

/** Утечка ссылки: старый URL умирает, клиент получает новый в боте. */
export const revokeSubscription = (subscriptionId: string) =>
  request<RevokeResult>(`/api/admin/subscriptions/${subscriptionId}/revoke`, { method: "POST" });

/**
 * Ручная выдача. Без subscriberId — новый человек без бота (нужна метка). days: null — бессрочно;
 * лимит null — без лимита. requestId — один на открытую форму: повтор не заведёт второго человека.
 */
export interface ManualGrantInput {
  subscriberId?: string;
  label?: string;
  days: number | null;
  deviceLimit?: number | null;
  trafficGb?: number | null;
  squadIds?: string[];
}

export interface ManualGrantResult {
  subscriptionId: string;
  subscriberId: string;
  status: string;
  expireAt: string | null;
  subscriptionUrl: string;
}

export const grantManualSubscription = (body: ManualGrantInput, requestId: string) =>
  request<ManualGrantResult>("/api/admin/subscriptions/manual", {
    ...post(body),
    headers: { "content-type": "application/json", "x-client-request-id": requestId },
  });

/** Продление: от текущего окончания, если оно впереди, иначе от сегодня. */
export const extendSubscription = (subscriptionId: string, days: number, requestId: string) =>
  request<{ subscriptionId: string; status: string; expireAt: string | null }>(
    `/api/admin/subscriptions/${subscriptionId}/extend`,
    { ...post({ days }), headers: { "content-type": "application/json", "x-client-request-id": requestId } },
  );

/** Отключить (disabled) или включить (снимает disabled и suspended). Повтор ничего не меняет. */
export const setSubscriptionEnabled = (subscriptionId: string, enabled: boolean) =>
  request<{ subscriptionId: string; status: string; changed: boolean }>(
    `/api/admin/subscriptions/${subscriptionId}/${enabled ? "enable" : "disable"}`,
    post(),
  );

// --- Поддержка --------------------------------------------------------------

export const CONVERSATION_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface ConversationListItem {
  id: string;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  tags: string[];
  lastMessageAt: string | null;
  createdAt: string;
  contact: { id: string; telegramUserId: number; username: string | null } | null;
}

export interface ConversationMessage {
  id: string;
  direction: "in" | "out";
  senderType: string;
  senderUserId: string | null;
  content: string;
  deliveryStatus: string;
  error: string | null;
  createdAt: string;
}

export const SUGGESTION_STATUSES = ["proposed", "accepted", "edited", "rejected", "sent"] as const;

export interface AiSuggestion {
  id: string;
  messageId: string | null;
  model: string | null;
  content: string;
  status: string;
  createdAt: string;
  /** На чём основана подсказка: оператор должен видеть источник. */
  documents: { id: string; title: string }[];
}

export interface Conversation {
  id: string;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  aiMode: string;
  tags: string[];
  lastMessageAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contact: {
    id: string;
    telegramUserId: number;
    username: string | null;
    languageCode: string | null;
    subscriberId: string | null;
  } | null;
  messages: ConversationMessage[];
  suggestions: AiSuggestion[];
}

export const getConversations = (status?: string) =>
  request<ConversationListItem[]>(
    `/api/admin/support/conversations${status ? `?status=${encodeURIComponent(status)}` : ""}`,
  );

export const getConversation = (id: string) =>
  request<Conversation>(`/api/admin/support/conversations/${id}`);

/** `suggestionId` — след того, что текст взят из подсказки; статус sent ставится после доставки. */
export const replyToConversation = (id: string, text: string, suggestionId?: string) =>
  request<{ messageId: string; deduped: boolean; delivered: boolean; reason?: string }>(
    `/api/admin/support/conversations/${id}/reply`,
    post(suggestionId ? { text, suggestionId } : { text }),
  );

export const patchConversation = (id: string, body: { status?: string; assigneeUserId?: string | null }) =>
  request<Conversation | null>(`/api/admin/support/conversations/${id}`, patch(body));

// --- Подсказки ИИ, база знаний, провайдер --------------------------------------

export interface SuggestionOutcome {
  status: "created" | "exists" | "skipped" | "failed";
  suggestionId?: string;
  reason?: string;
}

export const generateSuggestion = (conversationId: string) =>
  request<SuggestionOutcome>(`/api/admin/support/conversations/${conversationId}/suggest`, post());

/** Текст передаётся, только когда оператор его правил — тогда статус edited. */
export const acceptSuggestion = (id: string, text?: string) =>
  request<AiSuggestion>(`/api/admin/support/suggestions/${id}/accept`, post(text ? { text } : {}));

export const rejectSuggestion = (id: string) =>
  request<AiSuggestion>(`/api/admin/support/suggestions/${id}/reject`, post());

export interface KbDocument {
  id: string;
  title: string;
  body: string;
  source: string | null;
  lang: string;
  isActive: boolean;
  updatedAt: string;
}

export const getKbDocuments = () => request<KbDocument[]>("/api/admin/support/kb");

export const searchKbDocuments = (q: string) =>
  request<{ id: string; title: string; body: string }[]>(
    `/api/admin/support/kb/search?q=${encodeURIComponent(q)}`,
  );

export const createKbDocument = (body: { title: string; body: string; source?: string }) =>
  request<KbDocument>("/api/admin/support/kb", post(body));

export const updateKbDocument = (
  id: string,
  body: { title?: string; body?: string; source?: string | null; isActive?: boolean },
) => request<KbDocument>(`/api/admin/support/kb/${id}`, patch(body));

export interface AiProvider {
  id: string;
  provider: string;
  alias: string;
  isEnabled: boolean;
  model: string;
  /** С бэкенда приходят маскированными, значим только набор ключей. */
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  isConfigured: boolean;
}

export interface AiProviderSpec {
  provider: string;
  title: string;
  defaultModel: string;
  credentialFields: { key: string; label: string; required: boolean }[];
  settingFields: { key: string; label: string; type: "number" | "string"; default?: string | number }[];
}

export const getAiProviders = () => request<AiProvider[]>("/api/admin/ai/providers");

export const getAiProviderSpecs = () => request<AiProviderSpec[]>("/api/admin/ai/providers/specs");

export const createAiProvider = (body: {
  provider: string;
  alias: string;
  model?: string;
  credentials?: Record<string, string>;
  settings?: Record<string, unknown>;
}) => request<AiProvider>("/api/admin/ai/providers", post(body));

export const updateAiProvider = (
  id: string,
  body: {
    alias?: string;
    model?: string;
    isEnabled?: boolean;
    credentials?: Record<string, string>;
    settings?: Record<string, unknown>;
  },
) => request<AiProvider>(`/api/admin/ai/providers/${id}`, patch(body));

export const checkAiProvider = (id: string) =>
  request<{ ok: boolean; detail?: string }>(`/api/admin/ai/providers/${id}/check`, post());

// --- Продажи: воронка и кампании --------------------------------------------

export interface CampaignLink {
  id: string;
  campaignId: string;
  code: string;
  label: string | null;
  isArchived: boolean;
  registrations: number;
  payingUsers: number;
  revenueKopeks: number;
  createdAt: string;
}

export interface Campaign {
  id: string;
  slug: string;
  name: string;
  channel: string | null;
  status: string;
  costKopeks: number;
  createdAt: string;
  links: CampaignLink[];
}

export interface CampaignStats {
  campaign: Omit<Campaign, "links">;
  links: {
    id: string;
    code: string;
    label: string | null;
    isArchived: boolean;
    registrations: number;
    payments: number;
    payingUsers: number;
    revenueKopeks: number;
  }[];
  total: {
    registrations: number;
    payingUsers: number;
    revenueKopeks: number;
    costKopeks: number;
    profitKopeks: number;
    conversion: number;
    cpaKopeks: number | null;
  };
}

export interface Funnel {
  from: string;
  days: number;
  stages: { key: string; users: number; events: number }[];
  revenueKopeks: number;
  startToPaid: number;
  daily: { date: string; newSubscribers: number; payments: number; revenueKopeks: number }[];
}

export const getCampaigns = () => request<Campaign[]>("/api/admin/campaigns");

export const createCampaign = (body: { slug: string; name: string; channel?: string; costKopeks?: number }) =>
  request<Campaign>("/api/admin/campaigns", post(body));

export const updateCampaign = (
  id: string,
  body: { name?: string; channel?: string; status?: string; costKopeks?: number },
) => request<Campaign>(`/api/admin/campaigns/${id}`, patch(body));

export const createCampaignLink = (id: string, label?: string) =>
  request<CampaignLink & { startPayload: string }>(`/api/admin/campaigns/${id}/links`, post({ label }));

export const getCampaignStats = (id: string) => request<CampaignStats>(`/api/admin/campaigns/${id}/stats`);

export const getFunnel = (days: number) => request<Funnel>(`/api/admin/funnel?days=${days}`);

// --- Статистика трафика ------------------------------------------------------
// Суммы приходят из Postgres как bigint, а он сериализуется строкой: числом их
// объявлять нельзя, JSON.parse отдаст именно строку.

export interface TrafficOverview {
  periodDays: number;
  traffic: {
    up: string;
    down: string;
    subscribers: number;
    byDay: { day: string; up: string; down: string }[];
    byNode: { nodeId: string; nodeName: string; country: string | null; up: string; down: string }[];
  };
  /** Байтов по устройству здесь нет и не будет: Xray считает трафик по email подписки. */
  devices: {
    total: number;
    byPlatform: { os: string | null; devices: number; subscriptions: number }[];
  };
}

export interface TopSubscriber {
  shortUuid: string;
  subscriptionId: string | null;
  status: string | null;
  telegramId: number | null;
  up: string;
  down: string;
}

export interface SubscriptionDevice {
  hwid: string;
  deviceOs: string | null;
  osVer: string | null;
  deviceModel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export const getTrafficOverview = (days: number) =>
  request<TrafficOverview>(`/api/admin/stats/overview?days=${days}`);

export const getTopSubscribers = (days: number, limit = 25) =>
  request<TopSubscriber[]>(`/api/admin/stats/top-subscribers?days=${days}&limit=${limit}`);

export const getSubscriptionDevices = (shortUuid: string) =>
  request<SubscriptionDevice[]>(`/api/admin/usage/${encodeURIComponent(shortUuid)}/devices`);

// --- Рассылки и триггерные касания ------------------------------------------

export const SEGMENT_KINDS = ["all", "active", "inactive", "expiring", "segment"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export interface Broadcast {
  id: string;
  title: string;
  segmentKind: string;
  segmentId: string | null;
  bodyHtml: string;
  imageFileId: string | null;
  buttons: Record<string, unknown>[];
  status: string;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  throttlePerSec: number;
  createdAt: string;
  updatedAt: string;
  stats: { pending: number; sent: number; failed: number; skipped: number; total: number };
}

export interface Touchpoint {
  id: string;
  name: string;
  triggerType: string;
  triggerKey: string;
  delayHours: number;
  bodyHtml: string;
  buttons: Record<string, unknown>[];
  quietHours: { from: number; to: number } | null;
  isActive: boolean;
  createdAt: string;
}

export const getBroadcasts = () => request<Broadcast[]>("/api/admin/broadcasts");

export const getBroadcast = (id: string) => request<Broadcast>(`/api/admin/broadcasts/${id}`);

export const createBroadcast = (body: {
  title: string;
  segmentKind: SegmentKind;
  segmentId?: string;
  bodyHtml: string;
  throttlePerSec?: number;
  expiringDays?: number;
}) => request<{ broadcast: Omit<Broadcast, "stats">; recipients: number }>("/api/admin/broadcasts", post(body));

export const runBroadcast = (id: string) =>
  request<{ started: boolean }>(`/api/admin/broadcasts/${id}/run`, post());

export const cancelBroadcast = (id: string) =>
  request<{ ok: boolean; reason?: string }>(`/api/admin/broadcasts/${id}/cancel`, post());

export const getTouchpoints = () => request<Touchpoint[]>("/api/admin/touchpoints");

export const createTouchpoint = (body: {
  name: string;
  triggerKey: string;
  triggerType?: string;
  delayHours?: number;
  bodyHtml: string;
  isActive?: boolean;
}) => request<Touchpoint>("/api/admin/touchpoints", post(body));

export const updateTouchpoint = (
  id: string,
  body: {
    name?: string;
    triggerKey?: string;
    triggerType?: string;
    delayHours?: number;
    bodyHtml?: string;
    isActive?: boolean;
  },
) => request<Touchpoint>(`/api/admin/touchpoints/${id}`, patch(body));

// --- Тарифы -----------------------------------------------------------------

export interface Plan {
  id: string;
  code: string;
  title: string;
  periodDays: number;
  priceKopeks: number;
  trafficGb: number | null;
  deviceLimit: number | null;
  isTrial: boolean;
  isActive: boolean;
  sortOrder: number;
  squadIds: string[];
}

/**
 * Админский список тарифов. Не `/v1/plans`: публичный эндпоинт отдаёт только
 * включённые тарифы, а админке нужны и выключенные — иначе их нечем включить.
 */
export const getPlans = () => request<Plan[]>("/api/admin/plans");

/** `code` задаётся только при создании: он ключ тарифа (UNIQUE(org, code)). */
export const createPlan = (body: {
  code: string;
  title: string;
  periodDays: number;
  priceKopeks: number;
  trafficGb?: number;
  deviceLimit?: number;
  isTrial?: boolean;
  sortOrder?: number;
  squadIds?: string[];
}) => request<Plan>("/api/admin/plans", post(body));

export const updatePlan = (
  id: string,
  body: {
    title?: string;
    periodDays?: number;
    priceKopeks?: number;
    /** null снимает лимит; undefined — не трогать поле. */
    trafficGb?: number | null;
    deviceLimit?: number | null;
    isActive?: boolean;
    isTrial?: boolean;
    sortOrder?: number;
    squadIds?: string[];
  },
) => request<Plan>(`/api/admin/plans/${id}`, patch(body));
