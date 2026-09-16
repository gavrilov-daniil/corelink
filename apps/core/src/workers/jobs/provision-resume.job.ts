import { Injectable, Logger } from "@nestjs/common";
import { ProvisionService } from "../../nodes/provision.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Добор зависших прогонов авто-настройки: core умер посреди установки, прогон остался
 * running с протухшей арендой. ProvisionService.resume берёт именно такие (started_at
 * старше аренды) и перезапускает execute. Штатно провижн стартует сразу из сервиса —
 * сюда попадает только то, чей запуск не пережил рестарт.
 */
@Injectable()
export class ProvisionResumeJob implements JobRunner {
  readonly jobName = "provision-resume" as const;
  private readonly log = new Logger(ProvisionResumeJob.name);

  constructor(private readonly provision: ProvisionService) {}

  async run() {
    const { resumed } = await this.provision.resume();
    if (resumed.length > 0) this.log.log(`возобновлено прогонов: ${resumed.length}`);
    return { resumed };
  }
}
