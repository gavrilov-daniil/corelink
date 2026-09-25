import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, orgId } from "./_shared.js";
import { subscription } from "./subscribers.js";
import { cascadeLink, host } from "./infra.js";

// «Базовый балансер-конфиг» (клиентский скелет): balancer/observatory/loopback/policy/DNS
// + точки инъекции хостов. Версионный, бэкап при изменении (правило 4 vpn-network-2).
export const clientTemplate = pgTable("client_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
  baseJson: jsonb("base_json").$type<Record<string, unknown>>().notNull(),
  version: integer("version").notNull().default(1),
  serveJsonAtBase: boolean("serve_json_at_base").notNull().default(true),
  createdAt: createdAt(),
});

// VARIANTS-модель профилей подписки (🔀 Авто / 🇩🇪 / …). Правятся строками в БД, не хардкодом.
export const profile = pgTable("profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  remark: text("remark").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isAuto: boolean("is_auto").notNull().default(false),
  // false — профили «Россия»/«Белые списки»: РФ-ресурсы идут ЧЕРЕЗ туннель,
  // правило «РФ-домены → freedom» для них не добавляется
  ruSplit: boolean("ru_split").notNull().default(true),
}, (t) => [
  // Имя — натуральный ключ: по нему мастер локации находит «🔀 Авто»/профиль страны, а
  // будущий импорт с панели — уже заведённый профиль. Два профиля с одним именем — это
  // две одинаковые строки в списке у клиента.
  uniqueIndex("profile_org_remark_uq").on(t.orgId, t.remark),
]);

// Канал: direct = outbound как есть; cascade = клон exit-outbound с dialerProxy=front, оба плеча flow=vision.
export const channel = pgTable("channel", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  kind: text("kind").notNull(), // direct | cascade
  tag: text("tag").notNull(),
  srcTag: text("src_tag"), // для cascade: исходный exit-outbound
  newTag: text("new_tag"), // для cascade: тег клона
  cc: text("cc"),
  hostId: uuid("host_id").references(() => host.id),
  frontNodeId: uuid("front_node_id"),
  // без этой связи subgen не может проверить готовность каскада и публикует канал,
  // у которого одно плечо ещё не применило конфиг — трафик клиента уходит в никуда
  cascadeLinkId: uuid("cascade_link_id").references(() => cascadeLink.id),
}, (t) => [
  // Тег — это тег outbound'а в клиентском конфиге: два канала с одним тегом дают битый
  // конфиг. Заодно ключ идемпотентности канала локации (тег выводится из id ноды).
  uniqueIndex("channel_org_tag_uq").on(t.orgId, t.tag),
]);

// Какие каналы в профиле и на каком tier'е (1 = primary/direct, 2 = fallback/cascade).
export const profileChannel = pgTable("profile_channel", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  profileId: uuid("profile_id").notNull().references(() => profile.id),
  channelId: uuid("channel_id").notNull().references(() => channel.id),
  tier: integer("tier").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [uniqueIndex("profile_channel_uq").on(t.profileId, t.channelId)]);

// Пресеты под приложения (SRR Remnawave): какой формат отдаём по User-Agent.
export const subscriptionPreset = pgTable("subscription_preset", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
  format: text("format").notNull().default("happ_json"), // happ_json | xray_base64 | singbox | v2raytun_header
  profileIds: jsonb("profile_ids").$type<string[]>().notNull().default([]),
});

export const subResponseRule = pgTable("sub_response_rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  priority: integer("priority").notNull().default(0),
  matchHeader: text("match_header").notNull().default("user-agent"),
  matchOp: text("match_op").notNull().default("contains"), // contains | equals | regex
  matchValue: text("match_value").notNull(),
  presetId: uuid("preset_id").notNull().references(() => subscriptionPreset.id),
});

// Списки РФ-доменов для split-routing. Версионируются — конфиг ссылается на version.
export const routingDomainList = pgTable("routing_domain_list", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(), // ru_direct
  version: integer("version").notNull().default(1),
  sourceUrl: text("source_url"),
  checksum: text("checksum"),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("routing_domain_list_uq").on(t.orgId, t.name, t.version)]);

export const routingDomainEntry = pgTable("routing_domain_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  listId: uuid("list_id").notNull().references(() => routingDomainList.id),
  kind: text("kind").notNull(), // domain | full | regexp | cidr
  value: text("value").notNull(),
});

// Собранный per-subscription базовый конфиг. Кэш рендера — Redis; снапшот — аудит/откат.
export const subscriptionConfigSnapshot = pgTable("subscription_config_snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscription.id),
  configVersion: integer("config_version").notNull(),
  listVersion: integer("list_version").notNull(),
  baseJson: jsonb("base_json").$type<Record<string, unknown>>().notNull(),
  hash: text("hash").notNull(),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("sub_snapshot_uq").on(t.subscriptionId, t.configVersion, t.listVersion)]);
