import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { BotModule } from "../bot/bot.module.js";
import { BroadcastModule } from "../broadcast/broadcast.module.js";
import { NodesModule } from "../nodes/nodes.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { AlertService } from "./alert.service.js";
import { JobRegistry } from "./job.registry.js";
import { LeaderLockService } from "./leader-lock.service.js";
import { QueueService } from "./queue.service.js";
import { SchedulerService } from "./scheduler.service.js";
import { WorkersAdminController } from "./workers.admin.controller.js";
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
import { MonitoringModule } from "../monitoring/monitoring.module.js";

@Module({
  imports: [
    NodesModule, // rebuild desired-state (expire + safety-net sweep)
    BroadcastModule, // рассылки и касания — их run() вызывается, а не переписывается
    PaymentsModule, // ledger для реф-наград
    BotModule, // алерты операторам
    AiModule, // подсказки поддержке
    MonitoringModule, // синтетическая проба сети, детектор по трафику, чистка истории
  ],
  controllers: [WorkersAdminController],
  providers: [
    QueueService,
    LeaderLockService,
    SchedulerService,
    AlertService,
    SubscriptionExpireJob,
    SubscriptionNotifyExpireJob,
    InfraRenewalReminderJob,
    ReferralRewardPromoteJob,
    NodeReconcileSweepJob,
    TouchpointsRunJob,
    BroadcastResumeJob,
    PaymentReconcileJob,
    AbuseScanJob,
    AiSuggestJob,
    MaintenanceJob,
    ProvisionResumeJob,
    NodeProbeJob,
    TrafficDetectJob,
    JobRegistry,
  ],
  exports: [QueueService, SchedulerService, JobRegistry],
})
export class WorkersModule {}
