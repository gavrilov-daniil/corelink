import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, orgId, updatedAt } from "./_shared.js";
import { subscription } from "./subscribers.js";

// Физический хост/VPS.
//
// SSH-доступ описан одним из трёх способов (ssh_auth_type): паролем, приватным
// ключом или ссылкой в vault (прежнее поведение, ssh_ref). Сами пароль/ключ лежат
// в ssh_secret ЗАШИФРОВАННЫМИ (AES-256-GCM на SECRETS_MASTER_KEY, тот же механизм,
// что и креды мерчантов): наружу отдаётся только признак «задан», а модель угроз
// честная — ключ шифрования и шифртекст на одном боксе, поэтому это защита от дампа
// БД/бэкапа, а не от компрометации хоста. При vault_ref секрета в БД нет вовсе.
export const server = pgTable("server", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  hostname: text("hostname").notNull(),
  primaryIp: text("primary_ip").notNull(),
  extraIps: jsonb("extra_ips").$type<string[]>().notNull().default([]),
  country: text("country"),
  providerId: uuid("provider_id"),
  sshAuthType: text("ssh_auth_type").notNull().default("vault_ref"), // password | key | vault_ref
  sshUser: text("ssh_user"),
  sshPort: integer("ssh_port"), // NULL = 22
  sshRef: text("ssh_ref"), // ссылка в vault (для ssh_auth_type=vault_ref), не сам ключ
  sshSecret: jsonb("ssh_secret").$type<Record<string, string>>().notNull().default({}), // {password} | {privateKey, passphrase?}, зашифровано
  sshLastCheckAt: timestamp("ssh_last_check_at", { withTimezone: true }),
  sshLastCheckOk: boolean("ssh_last_check_ok"),
  sshLastCheckError: text("ssh_last_check_error"),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
  agentStatus: text("agent_status").notNull().default("unknown"),
  agentVersion: text("agent_version"),
  xrayVersion: text("xray_version"),
  egressHealth: jsonb("egress_health").$type<Record<string, unknown>>().notNull().default({}),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("server_org_hostname_uq").on(t.orgId, t.hostname)]);

// NODE-side Xray-скелет (routing/dns/policy/api/stats). 1 профиль = 1 нода (см. node_config_profile_uq).
export const configProfile = pgTable("config_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
  baseJson: jsonb("base_json").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  // Имя — натуральный ключ профиля: по нему импортёр находит уже заведённый профиль
  // при повторном прогоне. Без индекса второй прогон завёл бы профиль-двойник, а с ним
  // и вторую ноду (профиль занят → node_config_profile_uq пропускает), то есть удвоил
  // бы парк молча.
  uniqueIndex("config_profile_org_name_uq").on(t.orgId, t.name),
]);

// Шейп inbound'а + Reality-идентичность НА inbound'е (без отдельного node_inbound — YAGNI).
// privateKey Reality в БД НЕТ никогда (только на ноде); тут только public_key/short_ids.
export const inbound = pgTable("inbound", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  configProfileId: uuid("config_profile_id").notNull().references(() => configProfile.id),
  tag: text("tag").notNull(), // VLESS_REALITY_DE | ru2_RELAY_IN | RU2_FRONT ...
  protocol: text("protocol").notNull().default("vless"),
  network: text("network").notNull().default("tcp"),
  security: text("security").notNull().default("reality"),
  port: integer("port").notNull(),
  flow: text("flow").notNull().default("xtls-rprx-vision"), // пусто на grpc/xhttp/trojan
  sni: text("sni"),
  fingerprint: text("fingerprint").default("firefox"),
  realityPublicKey: text("reality_public_key"),
  realityPrivkeyRef: text("reality_privkey_ref"), // ссылка/маркер, не сам приватник
  shortIds: jsonb("short_ids").$type<string[]>().notNull().default([]),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  rawJson: jsonb("raw_json").$type<Record<string, unknown>>(),
}, (t) => [uniqueIndex("inbound_profile_tag_uq").on(t.configProfileId, t.tag)]);

// Логический Xray на сервере. Роли: exit | relay | front (могут совмещаться).
export const node = pgTable("node", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  serverId: uuid("server_id").notNull().references(() => server.id),
  configProfileId: uuid("config_profile_id").notNull().references(() => configProfile.id),
  name: text("name").notNull(),
  roles: jsonb("roles").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("provisioning"),
  consumptionMultiplier: integer("consumption_multiplier").notNull().default(1),
  trackTraffic: boolean("track_traffic").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  desiredConfigVersion: integer("desired_config_version").notNull().default(0),
  observedConfigHash: text("observed_config_hash"),
  createdAt: createdAt(),
}, (t) => [
  // Reality-идентичность живёт на inbound'е, а inbound принадлежит профилю: вторая нода
  // того же профиля затирает своим энроллментом public_key/short_ids первой, и каскадное
  // плечо relay→exit (оно читает Reality именно из inbound) начинает указывать на чужой ключ.
  // Отдельная таблица node_inbound была бы абстракцией под связь, которая фактически 1:1;
  // индекс делает инвариант проверяемым, а не декларативным.
  uniqueIndex("node_config_profile_uq").on(t.configProfileId),
]);

// Endpoint в подписке. Несколько host'ов на inbound = второй IP той же Reality-личности.
export const host = pgTable("host", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  inboundId: uuid("inbound_id").notNull().references(() => inbound.id),
  nodeId: uuid("node_id").notNull().references(() => node.id),
  remark: text("remark").notNull(),
  address: text("address").notNull(),
  port: integer("port").notNull(),
  sni: text("sni"),
  fingerprint: text("fingerprint"),
  alpn: text("alpn"),
  pbk: text("pbk"),
  sid: text("sid"),
  flow: text("flow"),
  tagPrefix: text("tag_prefix"), // для injectHosts / селектора балансера (префиксный!)
  isHidden: boolean("is_hidden").notNull().default(false),
  isDisabled: boolean("is_disabled").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  advanced: jsonb("advanced").$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [
  // Endpoint — это «куда клиент стучится за этой Reality-личностью», то есть пара
  // адрес:порт на конкретном inbound'е. Два таких host'а не значат ничего нового,
  // но в подписке дают два одинаковых канала, а импортёру — по строке на прогон.
  uniqueIndex("host_inbound_address_port_uq").on(t.inboundId, t.address, t.port),
]);

// Internal squad = access-control (какие inbound'ы даёт).
export const squad = pgTable("squad", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
});

export const squadInbound = pgTable("squad_inbound", {
  squadId: uuid("squad_id").notNull().references(() => squad.id),
  inboundId: uuid("inbound_id").notNull().references(() => inbound.id),
}, (t) => [uniqueIndex("squad_inbound_uq").on(t.squadId, t.inboundId)]);

export const subscriptionSquad = pgTable("subscription_squad", {
  subscriptionId: uuid("subscription_id").notNull().references(() => subscription.id),
  squadId: uuid("squad_id").notNull().references(() => squad.id),
}, (t) => [uniqueIndex("subscription_squad_uq").on(t.subscriptionId, t.squadId)]);

// Декларативное скрещивание relay↔exit. kind = маршрутизатор проекции.
export const cascadeLink = pgTable("cascade_link", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  kind: text("kind").notNull(), // server_forward | client_chain
  cc: text("cc").notNull(),
  relayNodeId: uuid("relay_node_id").references(() => node.id),
  frontNodeId: uuid("front_node_id").references(() => node.id),
  exitNodeId: uuid("exit_node_id").notNull().references(() => node.id),
  exitInboundTag: text("exit_inbound_tag").notNull(),
  linkUserUuid: uuid("link_user_uuid").notNull(), // ДЕТЕРМИНИРОВАННЫЙ: uuidv5(ns, cascade_link.id)
  // planned | exit_ready | relay_ready | active | retiring — канал виден в subgen ТОЛЬКО при active
  status: text("status").notNull().default("planned"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("cascade_link_uq").on(t.relayNodeId, t.exitNodeId, t.cc)]);

// Оркестрация: desired (в core) ↔ reported (от агента). Сходимость по config_hash.
export const nodeDesiredState = pgTable("node_desired_state", {
  nodeId: uuid("node_id").primaryKey().references(() => node.id),
  version: integer("version").notNull().default(0),
  configHash: text("config_hash").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  users: jsonb("users").$type<Array<{ email: string; uuid: string; level: number }>>().notNull().default([]),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const nodeReportedState = pgTable("node_reported_state", {
  nodeId: uuid("node_id").primaryKey().references(() => node.id),
  agentVersion: text("agent_version"),
  xrayVersion: text("xray_version"),
  appliedConfigHash: text("applied_config_hash"),
  sysStats: jsonb("sys_stats").$type<Record<string, unknown>>().notNull().default({}),
  egressHealth: jsonb("egress_health").$type<Record<string, unknown>>().notNull().default({}),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
});

// Энроллмент агента: bootstrap-токен (БД — authority, Redis только fast-path), mTLS-cert.
// Секретов в открытом виде тут нет: и bootstrap-, и agent-токен лежат только sha256-хешем.
export const nodeIdentity = pgTable("node_identity", {
  nodeId: uuid("node_id").primaryKey().references(() => node.id),
  agentPubkey: text("agent_pubkey"),
  certFingerprint: text("cert_fingerprint"),
  bootstrapTokenHash: text("bootstrap_token_hash"),
  bootstrapConsumedAt: timestamp("bootstrap_consumed_at", { withTimezone: true }),
  // Срок годности невостребованного bootstrap-токена. NULL = без срока (токены,
  // выпущенные до появления колонки, и явно выключенный TTL).
  bootstrapExpiresAt: timestamp("bootstrap_expires_at", { withTimezone: true }),
  // per-node секрет агента: токен ноды A не должен открывать ноду B
  agentTokenHash: text("agent_token_hash"),
  agentTokenIssuedAt: timestamp("agent_token_issued_at", { withTimezone: true }),
  agentEpoch: integer("agent_epoch").notNull().default(0), // namespace для report_id (переналитая нода)
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("node_identity_bootstrap_uq").on(t.bootstrapTokenHash),
  uniqueIndex("node_identity_agent_token_uq").on(t.agentTokenHash),
]);
