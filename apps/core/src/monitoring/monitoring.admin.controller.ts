import { Controller, Get } from "@nestjs/common";
import { MinRole } from "../auth/roles.js";
import { MonitoringService } from "./monitoring.service.js";

@Controller("api/admin/monitoring")
export class MonitoringAdminController {
  constructor(private readonly monitoring: MonitoringService) {}

  /** Саппорту — на чтение: «лежит ли нода» — первый вопрос, когда клиент пишет «нет интернета». */
  @Get()
  @MinRole("support")
  overview() {
    return this.monitoring.overview();
  }
}
