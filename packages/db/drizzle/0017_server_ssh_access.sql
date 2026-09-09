-- SSH-доступ к серверу переезжает из «только ссылка в vault» в полноценный доступ,
-- по которому платформа умеет сама подключаться. Способ описан ssh_auth_type:
--   vault_ref — прежнее поведение (ssh_ref указывает в vault, секрета в БД нет),
--   password  — пароль в ssh_secret,
--   key       — приватный ключ (+опц. passphrase) в ssh_secret.
--
-- Дефолт vault_ref: у заведённых до этой миграции серверов доступ описан ровно
-- ссылкой ssh_ref, и менять смысл их строки миграция не имеет права.
--
-- ssh_secret — креды ЗАШИФРОВАНЫ (AES-256-GCM на SECRETS_MASTER_KEY, тот же
-- механизм, что и credentials мерчанта): дамп/бэкап БД без ключа из env их не
-- раскрывает, наружу из API отдаётся только признак «задан».
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "ssh_auth_type" text DEFAULT 'vault_ref' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "ssh_user" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "ssh_port" integer;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "ssh_secret" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "ssh_last_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "ssh_last_check_ok" boolean;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "ssh_last_check_error" text;
