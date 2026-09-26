import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { loadConfig } from "./config.js";
import { AdminGuard } from "./common/admin.guard.js";
import { RateLimitGuard } from "./common/rate-limit.guard.js";
import { RateLimitService } from "./common/rate-limit.service.js";
import { ServiceTokenGuard } from "./common/service-token.guard.js";
import { DbModule } from "./db/db.module.js";
import { SubscriptionModule } from "./subscription/subscription.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { SupportModule } from "./support/support.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { BroadcastModule } from "./broadcast/broadcast.module.js";
import { NodesModule } from "./nodes/nodes.module.js";
import { SubscribersModule } from "./subscribers/subscribers.module.js";
import { ImportModule } from "./import/import.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { WorkersModule } from "./workers/workers.module.js";
import { MonitoringModule } from "./monitoring/monitoring.module.js";

@Controller()
class HealthController {
  private readonly cfg = loadConfig();

  // version — ревизия образа. Деплой сверяет её с выкатываемой: без этой сверки
  // «контейнер не пересоздался» неотличимо от успешного релиза.
  @Get("healthz")
  health() {
    return { ok: true, version: this.cfg.appVersion };
  }
}

@Module({
  imports: [
    DbModule,
    SubscriptionModule,
    AdminModule,
    PaymentsModule,
    NodesModule,
    SubscribersModule,
    ImportModule,
    AuthModule,
    SupportModule,
    CrmModule,
    BroadcastModule,
    WorkersModule,
    MonitoringModule,
  ],
  controllers: [HealthController],
  // Гварды на разные префиксы: /internal/* — сервисный токен, /api/admin/* — админский.
  // Порядок несущий: глобальные гварды выполняются в порядке объявления, и лимитер
  // обязан стоять первым — иначе перебор токена отсекался бы 401 до счётчика.
  providers: [
    RateLimitService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: ServiceTokenGuard },
    { provide: APP_GUARD, useClass: AdminGuard },
  ],
})
export class AppModule {}
