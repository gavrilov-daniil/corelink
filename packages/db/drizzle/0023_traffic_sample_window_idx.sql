-- Детектор по трафику клиентов (джоба traffic-detect) и abuse-scan читают traffic_sample
-- окнами по времени. Единственный индекс таблицы — уникальный (node_id, subject_type,
-- subject_key, window_start): диапазон по времени им не взять, и каждый прогон читал бы
-- всю историю, которая растёт окном в 30 с на каждого клиента каждой ноды.
CREATE INDEX IF NOT EXISTS "traffic_sample_org_window_idx" ON "traffic_sample" USING btree ("org_id", "window_start");
