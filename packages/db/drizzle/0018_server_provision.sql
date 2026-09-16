-- Прогон авто-настройки сервера по SSH: установка Xray + node-agent, запись конфига,
-- enable агента. Лог накопительный (секреты в нём маскируются), статус ведёт
-- worker-джоба provision-server. История — по строке на попытку.
--
-- Параллельные прогоны на один сервер отсекает advisory-lock в джобе, а не индекс:
-- повтор — это переустановка поверх (идемпотентный скрипт), а не конфликт, поэтому
-- уникального барьера на server_id здесь нет намеренно.
CREATE TABLE IF NOT EXISTS "provision_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"server_id" uuid NOT NULL,
	"node_id" uuid,
	"kind" text DEFAULT 'provision' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provision_run" ADD CONSTRAINT "provision_run_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provision_run" ADD CONSTRAINT "provision_run_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provision_run_server_idx" ON "provision_run" ("server_id","created_at");
