import { Module } from "@nestjs/common";
import { NodesModule } from "../nodes/nodes.module.js";
import { SubscriptionModule } from "../subscription/subscription.module.js";
import { MonitoringAdminController } from "./monitoring.admin.controller.js";
import { DEFAULT_PROBE_TIMING, MonitoringService, PROBE_TIMING } from "./monitoring.service.js";
import { PROBE_EXECUTOR, xrayCurlExecutor } from "./probe-executor.js";
import { TrafficDetectorService } from "./traffic-detector.service.js";

@Module({
  // SubscriptionRepository — каналы пробы тем же путём, что и выдача; NodeStateService —
  // пересборка нод, когда служебной подписке пробы открывается доступ
  imports: [SubscriptionModule, NodesModule],
  controllers: [MonitoringAdminController],
  providers: [
    MonitoringService,
    TrafficDetectorService,
    { provide: PROBE_EXECUTOR, useValue: xrayCurlExecutor },
    { provide: PROBE_TIMING, useValue: DEFAULT_PROBE_TIMING },
  ],
  exports: [MonitoringService, TrafficDetectorService],
})
export class MonitoringModule {}
