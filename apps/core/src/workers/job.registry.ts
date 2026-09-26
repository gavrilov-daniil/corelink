import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { JOB_NAMES, isJobName, type JobName, type JobRunner } from "./job.types.js";
import { SCHEDULE, SCHEDULE_TZ } from "./schedule.js";
import { SubscriptionExpireJob } from "./jobs/subscription-expire.job.js";
import { SubscriptionNotifyExpireJob } from "./jobs/subscription-notify-expire.job.js";
import { InfraRenewalReminderJob } from "./jobs/infra-renewal-reminder.job.js";
import { ReferralRewardPromoteJob } from "./jobs/referral-reward-promote.job.js";
import { NodeReconcileSweepJob } from "./jobs/node-reconcile-sweep.job.js";
import { TouchpointsRunJob } from "./jobs/touchpoints-run.job.js";
import { BroadcastResumeJob } from "./jobs/broadcast-resume.job.js";
import { PaymentReconcileJob } from "./jobs/payment-reconcile.job.js";
import { AbuseScanJob } from "./jobs/abuse-scan.job.js";
import { AiSuggestJob } from "./jobs/ai-suggest.job.js";
import { MaintenanceJob } from "./jobs/maintenance.job.js";
import { ProvisionResumeJob } from "./jobs/provision-resume.job.js";
import { NodeProbeJob } from "./jobs/node-probe.job.js";
import { TrafficDetectJob } from "./jobs/traffic-detect.job.js";

export interface JobRunRecord {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Реестр джоб: имя → исполнитель. Список явный, без автосканирования — иначе не видно,
 * что вообще крутится в проде. Последний запуск держится в памяти процесса (для отладки
 * из админки), источником истины он не является.
 */
@Injectable()
export class JobRegistry {
  private readonly log = new Logger(JobRegistry.name);
  private readonly runners = new Map<JobName, JobRunner>();
  private readonly lastRun = new Map<JobName, JobRunRecord>();

  constructor(
    subscriptionExpire: SubscriptionExpireJob,
    subscriptionNotifyExpire: SubscriptionNotifyExpireJob,
    infraRenewalReminder: InfraRenewalReminderJob,
    referralRewardPromote: ReferralRewardPromoteJob,
    nodeReconcileSweep: NodeReconcileSweepJob,
    touchpointsRun: TouchpointsRunJob,
    broadcastResume: BroadcastResumeJob,
    paymentReconcile: PaymentReconcileJob,
    abuseScan: AbuseScanJob,
    aiSuggest: AiSuggestJob,
    maintenance: MaintenanceJob,
    provisionResume: ProvisionResumeJob,
    nodeProbe: NodeProbeJob,
    trafficDetect: TrafficDetectJob,
  ) {
    const runners: JobRunner[] = [
      subscriptionExpire,
      subscriptionNotifyExpire,
      infraRenewalReminder,
      referralRewardPromote,
      nodeReconcileSweep,
      touchpointsRun,
      broadcastResume,
      paymentReconcile,
      abuseScan,
      aiSuggest,
      maintenance,
      provisionResume,
      nodeProbe,
      trafficDetect,
    ];
    for (const runner of runners) this.runners.set(runner.jobName, runner);
  }

  async run(name: string): Promise<Record<string, unknown>> {
    if (!isJobName(name)) throw new BadRequestException(`неизвестная джоба ${name}`);
    const runner = this.runners.get(name);
    if (!runner) throw new BadRequestException(`джоба ${name} не зарегистрирована`);

    const startedAt = new Date();
    try {
      const result = await runner.run();
      this.record(name, startedAt, { ok: true, result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`джоба ${name} упала: ${message}`);
      this.record(name, startedAt, { ok: false, error: message });
      throw err;
    }
  }

  list() {
    return JOB_NAMES.map((name) => ({
      name,
      cron: SCHEDULE[name],
      tz: SCHEDULE_TZ,
      lastRun: this.lastRun.get(name) ?? null,
    }));
  }

  private record(name: JobName, startedAt: Date, outcome: { ok: boolean; result?: Record<string, unknown>; error?: string }) {
    const finishedAt = new Date();
    this.lastRun.set(name, {
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      ...outcome,
    });
  }
}
