import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  bigint,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, orgId, updatedAt } from "./_shared.js";

// Корень tenant'а. Деплой для своей сети = одна строка (org #1).
export const organization = pgTable("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"), // active | suspended
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("organization_slug_uq").on(t.slug)]);

/**
 * АДМИН панели (оператор/админ). НЕ путать с subscriber (конечный VPN-юзер).
 *
 * Два способа входа на одну учётку: email+пароль и Telegram. Обязателен ровно один
 * из них, поэтому оба поля nullable: у заведённой из админки учётки нет telegram_id,
 * у пришедшей через Telegram — email.
 *
 * `status=pending` — самозаписавшийся через Telegram, доступа ещё нет: сессия такой
 * учётке не выдаётся, пока админ не подтвердит её и не назначит роль.
 */
export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  email: text("email"),
  passwordHash: text("password_hash"),
  telegramId: bigint("telegram_id", { mode: "number" }),
  telegramUsername: text("telegram_username"),
  displayName: text("display_name"),
  role: text("role").notNull().default("support"), // superadmin | admin | support
  status: text("status").notNull().default("pending"), // pending | active | disabled
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedByUserId: uuid("approved_by_user_id").references((): AnyPgColumn => user.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("user_org_email_uq").on(t.orgId, t.email),
  // Один telegram — одна учётка. NULL'ы Postgres считает различными, поэтому индекс
  // не мешает учёткам без привязки.
  uniqueIndex("user_org_telegram_uq").on(t.orgId, t.telegramId),
]);

/**
 * Настройки входа по Telegram (Web Login, OpenID Connect). Одна строка на org,
 * правится из админки.
 *
 * `client_secret` — секрет: лежит зашифрованным тем же AES-256-GCM, что и креды
 * мерчантов, наружу отдаётся только признак «задан». В отличие от прежнего
 * Login Widget, ключ входа больше не совпадает с токеном бота: утёкший секрет
 * даёт подделать вход, но не доступ к Bot API, и отзывается в BotFather отдельно.
 *
 * `redirect_uri` хранится, а не собирается из хоста: Telegram принимает только
 * заранее зарегистрированные URL, и значение обязано совпасть с BotFather
 * посимвольно — включая схему, порт и путь.
 *
 * `bot_token` остался от Login Widget и больше не используется. Колонка снимается
 * отдельным релизом: разрушающий DDL не едет вместе с кодом, который её знал.
 */
export const telegramAuthSetting = pgTable("telegram_auth_setting", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  isEnabled: boolean("is_enabled").notNull().default(false),
  botUsername: text("bot_username").notNull().default(""),
  botToken: text("bot_token").notNull().default(""),
  clientId: text("client_id").notNull().default(""),
  clientSecret: text("client_secret").notNull().default(""),
  redirectUri: text("redirect_uri").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("telegram_auth_setting_org_uq").on(t.orgId)]);

export const apiToken = pgTable("api_token", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  role: text("role").notNull().default("api"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("api_token_hash_uq").on(t.tokenHash)]);

/**
 * Сессия оператора админки. Пароль в браузере не храним — только случайный
 * токен, и тот в БД лежит хешем: утечка дампа не должна давать готовые сессии.
 */
export const operatorSession = pgTable("operator_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  userId: uuid("user_id").notNull().references(() => user.id),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("operator_session_token_uq").on(t.tokenHash)]);
