-- Общий squad: доступ к его локациям есть у КАЖДОЙ подписки org без строк
-- subscription_squad. Членство подразумевается флагом, поэтому новые, импортированные
-- и триальные подписки получают его без синхронизации, а смена тарифа его не снимает.
ALTER TABLE "squad" ADD COLUMN IF NOT EXISTS "for_all" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Общий squad у org ровно один: мастер локации находит его по флагу, а не по имени,
-- и повтор (второй прогон мастера, гонка двух вкладок) не заводит второй.
CREATE UNIQUE INDEX IF NOT EXISTS "squad_org_for_all_uq" ON "squad" ("org_id") WHERE "for_all";
--> statement-breakpoint
-- Имя — то, чем squad выбирают в тарифе и у локации; импортёр панели тоже сопоставляет
-- squad'ы по имени. Два одинаковых имени = неразличимые строки в админке.
CREATE UNIQUE INDEX IF NOT EXISTS "squad_org_name_uq" ON "squad" ("org_id","name");
