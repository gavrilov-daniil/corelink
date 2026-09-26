import { pgTable, uuid, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { createdAt, orgId } from "./_shared.js";
import { subscription } from "./subscribers.js";
import { node } from "./infra.js";

// Точка наблюдения синтетической пробы: откуда гоняется трафик через каналы.
// kind=dc — воркер платформы (из дата-центра; один на org — partial unique в миграции
// 0022), kind=home — устройство в домашней/мобильной сети РФ: только оно видит
// блокировки ТСПУ, которые из дата-центра не видны. У каждой точки своя служебная
// подписка с доступом ко всем squad'ам — её uuid нода и пускает.
export const monitorProbe = pgTable("monitor_probe", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  kind: text("kind").notNull(), // dc | home
  name: text("name").notNull(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscription.id),
  // sha256 токена домашней точки (этап 2); у dc NULL — воркер ходит без токена
  tokenHash: text("token_hash"),
  // Здоровье самой пробы: давний прогон = мониторинг молчит (воркер лежит), а не
  // «всё хорошо». Ошибка здесь — сбой пробы (нет xray/curl), а не падение нод.
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
});

// Результат одной проверки канала. node_id — нода host'а канала; SET NULL, чтобы
// удаление локации не уносило историю и не упиралось в FK.
export const probeResult = pgTable("probe_result", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  probeId: uuid("probe_id").notNull().references(() => monitorProbe.id),
  channelTag: text("channel_tag").notNull(),
  nodeId: uuid("node_id").references(() => node.id, { onDelete: "set null" }),
  ok: boolean("ok").notNull(),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("probe_result_probe_channel_idx").on(t.probeId, t.channelTag, t.checkedAt),
  index("probe_result_checked_idx").on(t.checkedAt),
]);

// Лента событий мониторинга: переходы «работал → упал» и обратно. Это и есть алерты,
// пока доставка идёт только в админку.
export const monitorEvent = pgTable("monitor_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  probeId: uuid("probe_id").references(() => monitorProbe.id),
  nodeId: uuid("node_id").references(() => node.id, { onDelete: "set null" }),
  channelTag: text("channel_tag"),
  kind: text("kind").notNull(), // probe_down | probe_up
  message: text("message"),
  createdAt: createdAt(),
}, (t) => [index("monitor_event_org_created_idx").on(t.orgId, t.createdAt)]);
