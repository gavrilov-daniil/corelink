import { Module } from "@nestjs/common";
import { SubscribersController } from "./subscribers.controller.js";
import { SubscribersService } from "./subscribers.service.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { CrmModule } from "../crm/crm.module.js";
import { NodesModule } from "../nodes/nodes.module.js";

@Module({
  // LedgerService для баланса, IdempotencyService — дабл-клик ручной выдачи,
  // AttributionService для атрибуции, NodeStateService — пересборка desired-state
  // после revoke (сменился vless_uuid) и после ручной выдачи/отключения
  imports: [PaymentsModule, CrmModule, NodesModule],
  controllers: [SubscribersController],
  providers: [SubscribersService],
  exports: [SubscribersService],
})
export class SubscribersModule {}
