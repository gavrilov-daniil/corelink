import { Module } from "@nestjs/common";
import { NodesModule } from "../nodes/nodes.module.js";
import { SubscriptionModule } from "../subscription/subscription.module.js";
import { MonitoringAdminController } from "./monitoring.admin.controller.js";
import { MonitoringService } from "./monitoring.service.js";
import { PROBE_EXECUTOR, xrayCurlExecutor } from "./probe-executor.js";

@Module({
  // SubscriptionRepository — каналы пробы тем же путём, что и выдача; NodeStateService —
  // пересборка нод, когда служебной подписке пробы открывается доступ
  imports: [SubscriptionModule, NodesModule],
  controllers: [MonitoringAdminController],
  providers: [MonitoringService, { provide: PROBE_EXECUTOR, useValue: xrayCurlExecutor }],
  exports: [MonitoringService],
})
export class MonitoringModule {}
