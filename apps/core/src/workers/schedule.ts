import type { JobName } from "./job.types.js";

export const SCHEDULE_TZ = "Europe/Moscow";

/**
 * Cron-расписание. Минуты разнесены и НЕ попадают на :00 и :30 — иначе всё бьёт
 * одновременно с любым другим шедулером на этой же машине и с внешними API-лимитами.
 */
export const SCHEDULE: Record<JobName, string> = {
  "subscription-expire": "7 * * * *",
  "touchpoints-run": "47 * * * *",
  "node-reconcile-sweep": "3-58/5 * * * *",
  "broadcast-resume": "1-56/5 * * * *",
  "referral-reward-promote": "23 3 * * *",
  "subscription-notify-expire": "13 10 * * *",
  "infra-renewal-reminder": "41 10 * * *",
  "payment-reconcile": "19,49 * * * *",
  "abuse-scan": "37 */2 * * *",
  // Страховка: штатно джоба ставится сразу при приёме сообщения, сюда попадают
  // только те диалоги, чья постановка не доехала (рестарт, недоступный Redis).
  "ai-suggest": "2-57/5 * * * *",
  "maintenance": "51 4 * * *",
  // Страховка: провижн стартует сразу из ProvisionService, сюда попадают только
  // прогоны, зависшие в running после падения core посреди установки.
  "provision-resume": "9-59/5 * * * *",
  // Синтетическая проба сети: трафик через каждый канал, как у клиента (см. MonitoringService).
  "node-probe": "4-59/5 * * * *",
  // Детектор по трафику клиентов: слоты по 5 минут, запуск через 2 минуты после конца слота —
  // агенты успевают прислать его окна (см. TrafficDetectorService).
  "traffic-detect": "2-57/5 * * * *",
};

/** Стабильный id планировщика: при рестарте расписание перезаписывается, а не плодится. */
export function schedulerId(name: JobName): string {
  return `cron:${name}`;
}
