-- Мониторинг: синтетическая проба гоняет трафик через каждый канал — как настоящий
-- клиент, — и копит историю. Без неё о лежащей ноде узнавали от клиентов, а проверка
-- «порт открыт / агент на связи» не видела ни сломанный Reality, ни блокировку ТСПУ.

-- Точки наблюдения: dc — воркер платформы, home — устройство в РФ-сети (этап 2).
CREATE TABLE IF NOT EXISTS "monitor_probe" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "subscription_id" uuid NOT NULL REFERENCES "subscription"("id"),
  "token_hash" text,
  "last_run_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Точка dc в org одна: воркер находит её по kind, повтор не заводит вторую.
CREATE UNIQUE INDEX IF NOT EXISTS "monitor_probe_org_dc_uq" ON "monitor_probe" ("org_id") WHERE "kind" = 'dc';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "probe_result" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
  "probe_id" uuid NOT NULL REFERENCES "monitor_probe"("id"),
  "channel_tag" text NOT NULL,
  "node_id" uuid REFERENCES "node"("id") ON DELETE SET NULL,
  "ok" boolean NOT NULL,
  "latency_ms" integer,
  "error" text,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "probe_result_probe_channel_idx" ON "probe_result" ("probe_id", "channel_tag", "checked_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "probe_result_checked_idx" ON "probe_result" ("checked_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitor_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
  "probe_id" uuid REFERENCES "monitor_probe"("id"),
  "node_id" uuid REFERENCES "node"("id") ON DELETE SET NULL,
  "channel_tag" text,
  "kind" text NOT NULL,
  "message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitor_event_org_created_idx" ON "monitor_event" ("org_id", "created_at");
