import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from "@nestjs/common";
import { MinRole } from "../auth/roles.js";
import { IdempotencyService } from "../common/idempotency.service.js";
import { SubscribersService, type ExpiryInput, type ManualGrantInput } from "./subscribers.service.js";

@Controller()
export class SubscribersController {
  constructor(
    private readonly subscribers: SubscribersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Бот зовёт на каждый /start: найти подписчика или создать. */
  @Post("internal/subscribers/resolve")
  resolve(
    @Body()
    body: {
      telegramId: number;
      username?: string;
      languageCode?: string;
      campaignLinkId?: string;
      referrerSubscriberId?: string;
    },
  ) {
    return this.subscribers.resolve(body);
  }

  @Get("internal/subscribers/:id/overview")
  overview(@Param("id") id: string) {
    return this.subscribers.overview(id);
  }

  @Get("v1/plans")
  plans() {
    return this.subscribers.listPlans();
  }

  @Post("internal/subscriptions/trial")
  trial(@Body() body: { subscriberId: string }) {
    return this.subscribers.activateTrial(body.subscriberId);
  }

  // --- подписки из админки ---

  /** Саппорту доступно на чтение: «сколько у меня устройств» — типовой вопрос в поддержку. */
  @Get("api/admin/subscriptions/:id/devices")
  @MinRole("support")
  devices(@Param("id") id: string) {
    return this.subscribers.listDevices(id);
  }

  /** hwid приходит из URL — админка обязана его энкодить, в нём бывает что угодно. */
  @Delete("api/admin/subscriptions/:id/devices/:hwid")
  unlinkDevice(@Param("id") id: string, @Param("hwid") hwid: string) {
    return this.subscribers.unlinkDevice(id, hwid);
  }

  /** Утечка ссылки: старый URL умирает, новый юзер получает из бота (overview). */
  @Post("api/admin/subscriptions/:id/revoke")
  revoke(@Param("id") id: string) {
    return this.subscribers.revoke(id);
  }

  /**
   * Ручная выдача: новому человеку без бота или подписчику из бота. Идемпотентно по
   * x-client-request-id: дабл-клик не заведёт второго человека.
   */
  @Post("api/admin/subscriptions/manual")
  grantManual(@Body() body: ManualGrantInput, @Headers("x-client-request-id") clientRequestId?: string) {
    return this.idempotency.run("subscription-manual", clientRequestId, () => this.subscribers.grantManual(body ?? {}));
  }

  /**
   * Точный срок (дата и время) или бессрочно. Идемпотентно без ключа: повтор ставит то же
   * значение, а expectedExpireAt ловит срок, сдвинутый оплатой, пока форма была открыта.
   */
  @Post("api/admin/subscriptions/:id/expiry")
  setExpiry(@Param("id") id: string, @Body() body: ExpiryInput) {
    return this.subscribers.setExpiry(id, body ?? {});
  }

  /** Отключение и включение идемпотентны сами: повтор статус не меняет. */
  @Post("api/admin/subscriptions/:id/disable")
  disable(@Param("id") id: string) {
    return this.subscribers.setEnabled(id, false);
  }

  @Post("api/admin/subscriptions/:id/enable")
  enable(@Param("id") id: string) {
    return this.subscribers.setEnabled(id, true);
  }

  // --- управление тарифами из админки ---

  @Get("api/admin/plans")
  adminPlans() {
    return this.subscribers.listAllPlans();
  }

  @Post("api/admin/plans")
  createPlan(
    @Body()
    body: {
      code: string;
      title: string;
      periodDays: number;
      priceKopeks: number;
      trafficGb?: number;
      deviceLimit?: number;
      isTrial?: boolean;
      sortOrder?: number;
      squadIds?: string[];
    },
  ) {
    return this.subscribers.createPlan(body);
  }

  @Patch("api/admin/plans/:id")
  updatePlan(
    @Param("id") id: string,
    @Body()
    body: {
      title?: string;
      periodDays?: number;
      priceKopeks?: number;
      trafficGb?: number | null;
      deviceLimit?: number | null;
      isActive?: boolean;
      isTrial?: boolean;
      sortOrder?: number;
      squadIds?: string[];
    },
  ) {
    return this.subscribers.updatePlan(id, body);
  }
}
