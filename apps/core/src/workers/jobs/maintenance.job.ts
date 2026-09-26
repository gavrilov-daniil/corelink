import { Injectable, Logger } from "@nestjs/common";
import { AlertService } from "../alert.service.js";
import { AuthService } from "../../auth/auth.service.js";
import { MonitoringService } from "../../monitoring/monitoring.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Обслуживание: чистка таблиц, которые иначе растут вечно.
 *
 * Методы чистки были написаны, но их никто не вызывал — `job_dedup` копил бы
 * по строке на каждый алерт, а `operator_session` хранил протухшие сессии
 * бесконечно. Ни то, ни другое не ломается сразу, поэтому и не замечается.
 */
@Injectable()
export class MaintenanceJob implements JobRunner {
  readonly jobName = "maintenance" as const;
  private readonly log = new Logger(MaintenanceJob.name);

  constructor(
    private readonly alerts: AlertService,
    private readonly auth: AuthService,
    private readonly monitoring: MonitoringService,
  ) {}

  async run() {
    const dedupKeys = await this.alerts.sweep(7);
    const sessions = await this.auth.purgeExpired();
    const probes = await this.monitoring.purge();

    if (dedupKeys > 0 || sessions > 0 || probes.results > 0) {
      this.log.log(
        `обслуживание: удалено ключей дедупа ${dedupKeys}, протухших сессий ${sessions}, ` +
          `результатов проб ${probes.results}, событий мониторинга ${probes.events}`,
      );
    }
    return { dedupKeys, sessions, probeResults: probes.results, monitorEvents: probes.events };
  }
}
