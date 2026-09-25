import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { LedgerService } from "../payments/ledger.service.js";
import { AttributionService } from "../crm/attribution.service.js";
import { NodeStateService } from "../nodes/node-state.service.js";

/** Неугадываемый идентификатор подписки в публичном URL. */
function generateShortUuid(): string {
  return randomBytes(12).toString("hex");
}

/** Соединение или транзакция — читающему хелперу достаточно select. */
type Selectable = Pick<Database, "select">;

@Injectable()
export class SubscribersService {
  private readonly log = new Logger(SubscribersService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly attribution: AttributionService,
    private readonly nodes: NodeStateService,
  ) {}

  /**
   * Точка входа из бота: найти подписчика по Telegram id или создать.
   * Атрибуция first-touch: campaign_link_id пишется только при создании
   * и больше никогда не перезаписывается.
   */
  async resolve(input: {
    telegramId: number;
    username?: string;
    languageCode?: string;
    /** Сырой payload из t.me/bot?start=... — код кампании резолвится здесь. */
    startPayload?: string;
    campaignLinkId?: string;
    referrerSubscriberId?: string;
  }) {
    const [existing] = await this.db
      .select()
      .from(schema.subscriber)
      .where(
        and(
          eq(schema.subscriber.orgId, this.cfg.defaultOrgId),
          eq(schema.subscriber.telegramId, input.telegramId),
        ),
      )
      .limit(1);

    // код кампании из deep-link; невалидный payload не должен ломать регистрацию — просто органика
    const link = input.campaignLinkId
      ? { id: input.campaignLinkId }
      : await this.attribution.resolveStartPayload(input.startPayload);

    if (existing) {
      if (input.username && input.username !== existing.username) {
        await this.db
          .update(schema.subscriber)
          .set({ username: input.username })
          .where(eq(schema.subscriber.id, existing.id));
      }
      // повторный приход по ссылке: событие пишется, но first-touch не переписывается
      if (link) await this.attribution.onRegistration(existing.id, link.id);
      return { subscriber: existing, created: false };
    }

    const [created] = await this.db
      .insert(schema.subscriber)
      .values({
        orgId: this.cfg.defaultOrgId,
        telegramId: input.telegramId,
        username: input.username,
        languageCode: input.languageCode,
        // campaign_link_id НЕ пишем здесь: first-touch claim делает AttributionService
        // условным UPDATE по IS NULL. Если заполнить сразу, claim не сработает
        // и регистрация будет засчитана как повторный приход.
        referrerSubscriberId: input.referrerSubscriberId,
        status: "active",
      })
      .onConflictDoNothing()
      .returning();

    // гонка двух параллельных /start — второй запрос перечитывает созданную запись.
    // Дальше он идёт тем же путём, что и выигравший: иначе у подписчика не будет
    // подписки, а регистрация по рекламной ссылке не засчитается.
    const subscriber = created ?? (await this.getByTelegramId(input.telegramId));
    if (!subscriber) throw new NotFoundException(`подписчик ${input.telegramId} не найден после гонки /start`);

    await this.ensureSubscription(subscriber.id);
    if (link) await this.attribution.onRegistration(subscriber.id, link.id);
    return { subscriber, created: Boolean(created) };
  }

  private async getByTelegramId(telegramId: number) {
    const [row] = await this.db
      .select()
      .from(schema.subscriber)
      .where(
        and(
          eq(schema.subscriber.orgId, this.cfg.defaultOrgId),
          eq(schema.subscriber.telegramId, telegramId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** У подписчика всегда есть запись подписки — она же держит идентичность в конфиге. */
  async ensureSubscription(subscriberId: string) {
    const existing = await this.findSubscription(this.db, subscriberId);
    if (existing) return existing;

    // Unique-индекса на subscriber_id нет и не будет: 0006 его заводила, 0007 сняла —
    // вторая подписка у клиента (куплена для близких) оказалась законным состоянием.
    // Значит инвариант «автоматически вторая подписка не создаётся» держится ТОЛЬКО
    // этой блокировкой: без неё параллельные /start дадут подписчику два разных URL,
    // и после оплаты обновится лишь один. Убирать нельзя.
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`subscription:${subscriberId}`}, 0))`);

      const raced = await this.findSubscription(tx, subscriberId);
      if (raced) return raced;

      const [created] = await tx
        .insert(schema.subscription)
        .values({
          orgId: this.cfg.defaultOrgId,
          subscriberId,
          shortUuid: generateShortUuid(),
          vlessUuid: randomUUID(),
          status: "inactive",
        })
        .returning();
      return created;
    });
  }

  /**
   * Вторая подписка у клиента законна (unique-индекса на subscriber_id нет), поэтому
   * порядок обязателен: без него Postgres отдавал бы произвольную строку и бот
   * показывал бы то одну ссылку, то другую. Берём самую раннюю — тем же порядком
   * продлевает оплату applyPlan, иначе деньги ушли бы не в ту подписку.
   */
  private async findSubscription(db: Selectable, subscriberId: string) {
    const [row] = await db
      .select()
      .from(schema.subscription)
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          eq(schema.subscription.subscriberId, subscriberId),
        ),
      )
      .orderBy(asc(schema.subscription.createdAt), asc(schema.subscription.id))
      .limit(1);
    return row ?? null;
  }

  /** Сводка для главного экрана бота. */
  async overview(subscriberId: string) {
    const subscription = await this.ensureSubscription(subscriberId);
    const balance = await this.ledger.getBalance(subscriberId);
    // Считаем ровно те устройства, что занимают слоты на выдаче (окно активности),
    // иначе бот показал бы «3 из 2» из-за давно забытого телефона.
    const activeSince = new Date(Date.now() - this.cfg.hwidActiveWindowDays * 86_400_000);
    const devices = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(schema.subscriberDevice)
      .where(
        and(
          eq(schema.subscriberDevice.subscriptionId, subscription.id),
          gte(schema.subscriberDevice.lastSeenAt, activeSince),
        ),
      );

    const [lastPayment] = await this.db
      .select()
      .from(schema.payment)
      .where(
        and(eq(schema.payment.subscriberId, subscriberId), eq(schema.payment.status, "paid")),
      )
      .orderBy(desc(schema.payment.paidAt))
      .limit(1);

    const active = subscription.status === "active" && (!subscription.expireAt || subscription.expireAt > new Date());

    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      active,
      expireAt: subscription.expireAt,
      subscriptionUrl: `https://${this.cfg.subPublicHost}/auto/${subscription.shortUuid}`,
      usedTrafficBytes: Number(subscription.usedTrafficBytes ?? 0),
      trafficLimitBytes: subscription.trafficLimitBytes ? Number(subscription.trafficLimitBytes) : null,
      deviceLimit: subscription.hwidDeviceLimit,
      devicesUsed: Number(devices[0]?.count ?? 0),
      balanceKopeks: balance,
      lastPaidAt: lastPayment?.paidAt ?? null,
    };
  }

  async listPlans() {
    return this.db
      .select()
      .from(schema.plan)
      .where(and(eq(schema.plan.orgId, this.cfg.defaultOrgId), eq(schema.plan.isActive, true)))
      .orderBy(schema.plan.sortOrder);
  }

  /** Для админки — включая выключенные тарифы. */
  async listAllPlans() {
    return this.db
      .select()
      .from(schema.plan)
      .where(eq(schema.plan.orgId, this.cfg.defaultOrgId))
      .orderBy(schema.plan.sortOrder);
  }

  async createPlan(input: {
    code: string;
    title: string;
    periodDays: number;
    priceKopeks: number;
    trafficGb?: number;
    deviceLimit?: number;
    isTrial?: boolean;
    sortOrder?: number;
    squadIds?: string[];
  }) {
    await this.assertPlanSquads(input.squadIds);
    const [row] = await this.db
      .insert(schema.plan)
      .values({
        orgId: this.cfg.defaultOrgId,
        code: input.code,
        title: input.title,
        periodDays: input.periodDays,
        priceKopeks: input.priceKopeks,
        trafficGb: input.trafficGb,
        deviceLimit: input.deviceLimit,
        isTrial: input.isTrial ?? false,
        sortOrder: input.sortOrder ?? 0,
        squadIds: input.squadIds ?? [],
      })
      .returning();
    return row;
  }

  async updatePlan(
    planId: string,
    patch: {
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
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) values[key] = value;
    }
    if (Object.keys(values).length === 0) throw new BadRequestException("нечего обновлять");
    await this.assertPlanSquads(patch.squadIds);

    const [row] = await this.db
      .update(schema.plan)
      .set(values)
      .where(and(eq(schema.plan.orgId, this.cfg.defaultOrgId), eq(schema.plan.id, planId)))
      .returning();
    if (!row) throw new NotFoundException("тариф не найден");
    return row;
  }

  /**
   * squad'ы тарифа существуют в org? Чужой id в тарифе ронял бы фулфилмент оплаты:
   * вставка subscription_squad падает по FK внутри транзакции платежа — деньги
   * приняты, дней нет.
   */
  private async assertPlanSquads(squadIds: string[] | undefined): Promise<void> {
    if (squadIds === undefined) return;
    if (!Array.isArray(squadIds)) throw new BadRequestException("squadIds: ожидается массив uuid");
    if (squadIds.length === 0) return;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const malformed = squadIds.filter((id) => typeof id !== "string" || !UUID_RE.test(id));
    if (malformed.length > 0) throw new BadRequestException(`squadIds: не uuid — ${malformed.join(", ")}`);

    const found = await this.db
      .select({ id: schema.squad.id })
      .from(schema.squad)
      .where(and(eq(schema.squad.orgId, this.cfg.defaultOrgId), inArray(schema.squad.id, squadIds)));
    const missing = squadIds.filter((id) => !found.some((f) => f.id === id));
    if (missing.length > 0) throw new BadRequestException(`squadIds: не найдены ${missing.join(", ")}`);
  }

  /**
   * Активация триала. Выдаётся один раз на подписчика — отметка trial_used_at
   * ставится условным UPDATE, поэтому параллельные запросы не выдадут два триала.
   */
  async activateTrial(subscriberId: string) {
    const [plan] = await this.db
      .select()
      .from(schema.plan)
      .where(
        and(
          eq(schema.plan.orgId, this.cfg.defaultOrgId),
          eq(schema.plan.isTrial, true),
          eq(schema.plan.isActive, true),
        ),
      )
      .limit(1);
    if (!plan) throw new BadRequestException("триал не настроен");

    const claimed = await this.db
      .update(schema.subscriber)
      .set({ trialUsedAt: new Date() })
      .where(
        and(
          eq(schema.subscriber.id, subscriberId),
          sql`${schema.subscriber.trialUsedAt} is null`,
        ),
      )
      .returning();

    if (claimed.length === 0) throw new BadRequestException("триал уже использован");

    const subscription = await this.ensureSubscription(subscriberId);
    const expireAt = new Date(Date.now() + plan.periodDays * 86_400_000);

    await this.db
      .update(schema.subscription)
      .set({
        status: "trial",
        expireAt,
        trafficLimitBytes: plan.trafficGb ? plan.trafficGb * 1024 ** 3 : null,
        hwidDeviceLimit: plan.deviceLimit,
        updatedAt: new Date(),
      })
      .where(eq(schema.subscription.id, subscription.id));

    // без членства в squad'ах тарифа юзер не попадёт в desired-state ноды
    // и получит рабочий на вид конфиг, по которому Xray разорвёт хендшейк
    if (plan.squadIds.length > 0) {
      await this.db
        .insert(schema.subscriptionSquad)
        .values(plan.squadIds.map((squadId) => ({ subscriptionId: subscription.id, squadId })))
        .onConflictDoNothing();
    }

    this.log.log(`триал выдан подписчику ${subscriberId} до ${expireAt.toISOString()}`);
    return { ok: true, expireAt, subscriptionUrl: `https://${this.cfg.subPublicHost}/auto/${subscription.shortUuid}` };
  }

  /** Устройства подписки — карточка подписчика в админке и разбор «почему лимит». */
  async listDevices(subscriptionId: string) {
    await this.getSubscription(subscriptionId);
    return this.db
      .select()
      .from(schema.subscriberDevice)
      .where(eq(schema.subscriberDevice.subscriptionId, subscriptionId))
      .orderBy(schema.subscriberDevice.firstSeenAt);
  }

  /**
   * Отвязка устройства: слот освобождается сразу, следующий опрос клиента
   * заводит запись заново. Повторный вызов — те же ноль строк, это не ошибка.
   */
  async unlinkDevice(subscriptionId: string, hwid: string) {
    await this.getSubscription(subscriptionId);
    const removed = await this.db
      .delete(schema.subscriberDevice)
      .where(
        and(
          eq(schema.subscriberDevice.subscriptionId, subscriptionId),
          eq(schema.subscriberDevice.hwid, hwid),
        ),
      )
      .returning({ id: schema.subscriberDevice.id });
    this.log.log(`подписка ${subscriptionId}: отвязано устройство ${hwid.slice(0, 16)} (${removed.length})`);
    return { ok: true, removed: removed.length };
  }

  /**
   * Revoke — штатный ответ на утечку ссылки: старый URL перестаёт работать.
   * Меняем оба секрета сразу. Только short_uuid недостаточно: vless_uuid из утёкшего
   * тела подписки — это рабочая идентичность на нодах, по ней воруют трафик.
   *
   * Идемпотентности здесь нет и быть не может: каждый вызов — новая пара секретов.
   * Повторный revoke не ломает данные, но выданный юзеру URL снова протухает.
   */
  async revoke(subscriptionId: string) {
    const revokedAt = new Date();
    const shortUuid = generateShortUuid();

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.subscription)
        .set({ shortUuid, vlessUuid: randomUUID(), subRevokedAt: revokedAt, updatedAt: revokedAt })
        .where(
          and(
            eq(schema.subscription.orgId, this.cfg.defaultOrgId),
            eq(schema.subscription.id, subscriptionId),
          ),
        )
        .returning();
      if (!row) throw new NotFoundException("подписка не найдена");

      // Устройства принадлежали утёкшей ссылке: оставить их — значит отдать
      // слоты лимита тому, у кого ссылка и осталась.
      await tx
        .delete(schema.subscriberDevice)
        .where(eq(schema.subscriberDevice.subscriptionId, subscriptionId));
      return row;
    });

    // vless_uuid — идентичность клиента в конфиге ноды. Без пересборки desired-state
    // ноды продолжают знать старый uuid, и новый конфиг у клиента не заработает.
    const rebuild = await this.nodes.rebuildAll();
    this.log.warn(`подписка ${subscriptionId}: revoke, новый short_uuid ${shortUuid}, нод пересобрано ${rebuild.changed.length}`);

    return {
      ok: true,
      subscriptionId,
      shortUuid: updated.shortUuid,
      subscriptionUrl: `https://${this.cfg.subPublicHost}/auto/${updated.shortUuid}`,
      revokedAt,
      nodesChanged: rebuild.changed.length,
      nodesFailed: rebuild.failed.length,
    };
  }

  private async getSubscription(subscriptionId: string) {
    const [row] = await this.db
      .select()
      .from(schema.subscription)
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          eq(schema.subscription.id, subscriptionId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("подписка не найдена");
    return row;
  }

  async getById(subscriberId: string) {
    const [row] = await this.db
      .select()
      .from(schema.subscriber)
      .where(
        and(eq(schema.subscriber.orgId, this.cfg.defaultOrgId), eq(schema.subscriber.id, subscriberId)),
      )
      .limit(1);
    if (!row) throw new NotFoundException("подписчик не найден");
    return row;
  }
}
