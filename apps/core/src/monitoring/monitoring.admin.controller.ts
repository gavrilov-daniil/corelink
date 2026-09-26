import { Controller, Get } from "@nestjs/common";
import { MinRole } from "../auth/roles.js";
import { MonitoringService } from "./monitoring.service.js";
import { TrafficDetectorService } from "./traffic-detector.service.js";

@Controller("api/admin/monitoring")
export class MonitoringAdminController {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly traffic: TrafficDetectorService,
  ) {}

  /** Саппорту — на чтение: «лежит ли нода» — первый вопрос, когда клиент пишет «нет интернета». */
  @Get()
  @MinRole("support")
  async overview() {
    const [view, traffic] = await Promise.all([this.monitoring.overview(), this.traffic.evaluate()]);
    return { ...view, traffic };
  }
}
