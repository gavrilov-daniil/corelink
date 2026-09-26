import { Injectable } from "@nestjs/common";
import { TrafficDetectorService } from "../../monitoring/traffic-detector.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Детектор по трафику настоящих клиентов. Идемпотентен: вердикт считается заново из
 * traffic_sample, событие пишется только на смене состояния ноды или сети.
 */
@Injectable()
export class TrafficDetectJob implements JobRunner {
  readonly jobName = "traffic-detect" as const;

  constructor(private readonly detector: TrafficDetectorService) {}

  run() {
    return this.detector.run();
  }
}
