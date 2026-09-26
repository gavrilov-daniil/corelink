export const JOB_NAMES = [
  "subscription-expire",
  "subscription-notify-expire",
  "infra-renewal-reminder",
  "referral-reward-promote",
  "node-reconcile-sweep",
  "touchpoints-run",
  "broadcast-resume",
  "payment-reconcile",
  "abuse-scan",
  "ai-suggest",
  "maintenance",
  "provision-resume",
  "node-probe",
  "traffic-detect",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

/**
 * Контракт джобы. Каждая идемпотентна: повторный прогон в том же окне не меняет результат.
 * Ключ дедупа у каждой свой и описан в её файле.
 */
export interface JobRunner {
  readonly jobName: JobName;
  run(): Promise<Record<string, unknown>>;
}
