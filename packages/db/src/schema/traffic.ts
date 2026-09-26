import { pgTable, uuid, text, bigint, integer, timestamp, jsonb, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
import { orgId } from "./_shared.js";
import { node } from "./infra.js";
import { subscription } from "./subscribers.js";

// Батч-репорт агента. Дедуп реплеев на уровне батча.
// report_id namespace'ится agent_epoch (переналитая нода не коллизится со старыми id).
export const trafficReport = pgTable("traffic_report", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  nodeId: uuid("node_id").notNull().references(() => node.id),
  reportId: text("report_id").notNull(), // "<agent_epoch>:<seq>"
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [uniqueIndex("traffic_report_uq").on(t.nodeId, t.reportId)]);

// СЫРЬЁ: дельты за окно (ledger-first). Дедуп at-least-once на unique(node,subject,window_start).
export const trafficSample = pgTable("traffic_sample", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  nodeId: uuid("node_id").notNull().references(() => node.id),
  subjectType: text("subject_type").notNull(), // user | inbound | outbound
  subjectKey: text("subject_key").notNull(), // email / tag
  upDelta: bigint("up_delta", { mode: "number" }).notNull().default(0),
  downDelta: bigint("down_delta", { mode: "number" }).notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("traffic_sample_uq").on(t.nodeId, t.subjectType, t.subjectKey, t.windowStart),
  // окна по времени (детектор по трафику, abuse-scan): уникальным индексом диапазон не взять
  index("traffic_sample_org_window_idx").on(t.orgId, t.windowStart),
]);

// АГРЕГАТ (пересчитывается из samples, руками не правится).
export const trafficDaily = pgTable("traffic_daily", {
  orgId: orgId(),
  day: text("day").notNull(), // YYYY-MM-DD
  subjectType: text("subject_type").notNull(),
  subjectKey: text("subject_key").notNull(),
  nodeId: uuid("node_id").notNull().references(() => node.id),
  up: bigint("up", { mode: "number" }).notNull().default(0),
  down: bigint("down", { mode: "number" }).notNull().default(0),
}, (t) => [primaryKey({ columns: [t.orgId, t.day, t.subjectType, t.subjectKey, t.nodeId] })]);

// online / last-seen (перезапись, только последнее). Аномалия ip_count → сигнал утечки подписки.
export const onlineState = pgTable("online_state", {
  subscriptionId: uuid("subscription_id").primaryKey().references(() => subscription.id),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastIp: text("last_ip"),
  ipCount: integer("ip_count").notNull().default(0),
  nodeId: uuid("node_id").references(() => node.id),
});
