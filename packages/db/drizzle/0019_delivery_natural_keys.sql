-- Натуральные ключи слоя выдачи: мастер локации сам заводит канал и кладёт его в
-- «🔀 Авто» и профиль страны, поэтому повтор (второй прогон мастера, будущий импорт с
-- панели) обязан находить уже существующие строки, а не плодить двойники. Барьер —
-- индекс, а не проверка в коде: между SELECT и INSERT есть гонка.
--
-- profile.remark — имя профиля в списке у клиента: два одинаковых имени = две
-- одинаковые строки в HAPP. channel.tag — тег outbound'а: дубль ломает конфиг.
CREATE UNIQUE INDEX IF NOT EXISTS "profile_org_remark_uq" ON "profile" ("org_id","remark");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_org_tag_uq" ON "channel" ("org_id","tag");
