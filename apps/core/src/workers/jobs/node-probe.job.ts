import { Injectable } from "@nestjs/common";
import { MonitoringService } from "../../monitoring/monitoring.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Синтетическая проба из дата-центра по всем каналам. Идемпотентна по смыслу: каждый
 * прогон — новый срез состояния, событие в ленте пишется только на смене состояния канала.
 */
@Injectable()
export class NodeProbeJob implements JobRunner {
  readonly jobName = "node-probe" as const;

  constructor(private readonly monitoring: MonitoringService) {}

  run() {
    return this.monitoring.runDcProbe();
  }
}
