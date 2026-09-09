-- Вход по Telegram переезжает с Login Widget на Web Login (OpenID Connect).
--
-- Ключ проверки входа перестаёт быть токеном бота: теперь это отдельная пара
-- client_id / client_secret из BotFather. Практическая разница — радиус утечки:
-- токен бота открывал ещё и Bot API (рассылки от имени бренда), отзыв означал
-- переезд всех вебхуков; client_secret отзывается отдельно и не даёт ничего,
-- кроме подделки входа.
--
-- redirect_uri хранится строкой: Telegram принимает только заранее
-- зарегистрированные URL и сверяет их посимвольно, поэтому собирать его из
-- хоста на лету нельзя — расхождение в схеме или пути ломает вход молча.
ALTER TABLE "telegram_auth_setting" ADD COLUMN IF NOT EXISTS "client_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_auth_setting" ADD COLUMN IF NOT EXISTS "client_secret" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_auth_setting" ADD COLUMN IF NOT EXISTS "redirect_uri" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- Настройки виджета к новому флоу неприменимы: со старым токеном и без client_id
-- вход всё равно не заработает, а включённый флаг рисовал бы нерабочую кнопку.
-- Токен бота стирается здесь же — мёртвый секрет не должен лежать в базе и в дампах.
UPDATE "telegram_auth_setting" SET "is_enabled" = false, "bot_token" = '';
