import { Module } from "@nestjs/common";
import { BotModule } from "../bot/bot.module.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { SubscriptionController } from "./subscription.controller.js";
import { ProfilesAdminController } from "./profiles.admin.controller.js";
import { SubscriptionService } from "./subscription.service.js";
import { SubscriptionRepository } from "./subscription.repository.js";

@Module({
  imports: [BotModule],
  controllers: [SubscriptionController, ProfilesAdminController],
  // RateLimitService держит своё соединение с Redis: у очереди BullMQ настройки
  // соединения другие (бесконечные ретраи блокирующих команд), и делить их нельзя.
  providers: [SubscriptionService, SubscriptionRepository, RateLimitService],
  // репозиторий нужен мониторингу: проба берёт каналы тем же путём, что и выдача
  exports: [SubscriptionRepository],
})
export class SubscriptionModule {}
