/**
 * Кнопки админки ставят джобу воркеру: неизвестное имя и лежащая очередь — честная ошибка,
 * а не молчаливое «поставлено», после которого оператор ждёт результата, которого не будет.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import type { JobRegistry } from "./job.registry.js";
import type { QueueService } from "./queue.service.js";
import { WorkersAdminController } from "./workers.admin.controller.js";

function controller(queued: boolean) {
  const calls: string[] = [];
  const queue = {
    enqueue: async (name: string) => {
      calls.push(name);
      return queued;
    },
  } as unknown as QueueService;
  return { calls, api: new WorkersAdminController({} as JobRegistry, queue) };
}

describe("POST /api/admin/jobs/:name/enqueue", () => {
  it("ставит известную джобу в очередь", async () => {
    const { calls, api } = controller(true);
    assert.deepEqual(await api.enqueue("node-probe"), { queued: true });
    assert.deepEqual(calls, ["node-probe"]);
  });

  it("неизвестная джоба — 400, в очередь ничего не уходит", async () => {
    const { calls, api } = controller(true);
    await assert.rejects(() => api.enqueue("drop-database"), BadRequestException);
    assert.deepEqual(calls, []);
  });

  it("очередь недоступна — 503, а не «поставлено»", async () => {
    const { api } = controller(false);
    await assert.rejects(() => api.enqueue("node-probe"), ServiceUnavailableException);
  });
});
