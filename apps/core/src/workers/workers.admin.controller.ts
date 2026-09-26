import { BadRequestException, Controller, Get, Param, Post, ServiceUnavailableException } from "@nestjs/common";
import { JobRegistry } from "./job.registry.js";
import { isJobName } from "./job.types.js";
import { QueueService } from "./queue.service.js";

/**
 * Ручной прогон джоб. run — синхронно, ответ содержит результат прогона: отладка и
 * degraded-режим (нет Redis — расписания нет, но джобы должны запускаться).
 * enqueue — то же воркером через очередь, для кнопок в админке.
 */
@Controller("api/admin")
export class WorkersAdminController {
  constructor(
    private readonly registry: JobRegistry,
    private readonly queue: QueueService,
  ) {}

  @Get("jobs")
  list() {
    return { degraded: this.queue.degraded, jobs: this.registry.list() };
  }

  @Post("jobs/:name/run")
  run(@Param("name") name: string) {
    return this.registry.run(name);
  }

  /**
   * Прогон воркером, а не в HTTP-запросе: джоба с сетевыми вызовами (проба каналов) не должна
   * держать запрос и гоняться параллельно в api. Повторный клик в окне схлопывается в один прогон.
   */
  @Post("jobs/:name/enqueue")
  async enqueue(@Param("name") name: string) {
    if (!isJobName(name)) throw new BadRequestException(`неизвестная джоба ${name}`);
    if (!(await this.queue.enqueue(name))) throw new ServiceUnavailableException("очередь недоступна — джоба не поставлена");
    return { queued: true };
  }
}
