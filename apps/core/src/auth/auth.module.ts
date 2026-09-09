import { Global, Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { OidcStore } from "./oidc-store.js";
import { TelegramOidcService } from "./telegram-oidc.service.js";

/** Global: AdminGuard живёт в APP_GUARD и должен видеть AuthService без импорта в каждый модуль. */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, TelegramOidcService, OidcStore],
  exports: [AuthService, TelegramOidcService],
})
export class AuthModule {}
