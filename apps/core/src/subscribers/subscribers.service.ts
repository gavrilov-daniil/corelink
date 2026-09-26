import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Потолок ручной выдачи и продления — 10 лет; больше — это «бессрочно», а не опечатка. */
const MAX_GRANT_DAYS = 3650;

/**
 * Ручная выдача из админки. Без subscriberId — новый человек без бота (нужна метка).
 * Лимит null — «без лимита»; не прислан — у подписки из бота не трогаем.
 */
export interface ManualGrantInput {
  subscriberId?: string;
  label?: string;
  /** Срок в днях; null — бессрочно. */
  days?: number | null;
  deviceLimit?: number | null;
  trafficGb?: number | null;
  /** Свои squad'ы — добавляются к имеющимся; общий у всех и так. */
  squadIds?: string[];
}

interface Grant {
  days: number | null;
  deviceLimit: number | null | undefined;
  trafficGb: number | null | undefined;
  squadIds: string[];
}

/**
 * Статус после выдачи или продления: блокировку (disabled / suspended) они не снимают —
 * это делает только явное «Включить», иначе продление молча вернуло бы доступ
 * приостановленному за abuse.
 */
const statusAfterGrant = sql`case when ${schema.subscription.status} in ('disabled', 'suspended')
  then ${schema.subscription.status} else 'active' end`;

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
    await this.assertSquadsExist(input.squadIds);
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
    await this.assertSquadsExist(patch.squadIds);

    const [row] = await this.db
      .update(schema.plan)
      .set(values)
      .where(and(eq(schema.plan.orgId, this.cfg.defaultOrgId), eq(schema.plan.id, planId)))
      .returning();
    if (!row) throw new NotFoundException("тариф не найден");
    return row;
  }

  /**
   * squad'ы существуют в org? Чужой id в тарифе ронял бы фулфилмент оплаты: вставка
   * subscription_squad падает по FK внутри транзакции платежа — деньги приняты, дней нет.
   * При ручной выдаче тот же FK уронил бы её целиком.
   */
  private async assertSquadsExist(squadIds: string[] | undefined): Promise<void> {
    if (squadIds === undefined) return;
    if (!Array.isArray(squadIds)) throw new BadRequestException("squadIds: ожидается массив uuid");
    if (squadIds.length === 0) return;
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

  /**
   * Ручная выдача из админки — без оплаты и без бота.
   *
   * Новому человеку заводится подписчик без Telegram: метка лежит в description, по ней
   * его находят в списке. Подписчику из бота доступ выдаётся на ОСНОВНУЮ подписку, а не
   * на вторую: бот показывает клиенту самую раннюю, и вторую ссылку тот бы не увидел.
   *
   * Денег здесь нет — ledger не трогаем. Повтор запроса гасит x-client-request-id на
   * контроллере: без него дабл-клик завёл бы двух человек или начислил дни дважды.
   */
  async grantManual(input: ManualGrantInput) {
    const grant: Grant = {
      days: grantDays(input.days, true),
      deviceLimit: optionalLimit(input.deviceLimit, "deviceLimit", 100),
      trafficGb: optionalLimit(input.trafficGb, "trafficGb", 100_000),
      squadIds: input.squadIds ?? [],
    };
    await this.assertSquadsExist(input.squadIds);

    const subscription =
      input.subscriberId === undefined
        ? await this.createManualSubscriber(manualLabel(input.label), grant)
        : await this.grantToSubscriber(requireUuid(input.subscriberId, "subscriberId"), grant);

    // статус и срок — это список клиентов на нодах: без пересборки доступ не заработает
    const rebuild = await this.nodes.rebuildAll();
    this.log.log(
      `подписка ${subscription.id}: ручная выдача до ${subscription.expireAt?.toISOString() ?? "бессрочно"}, ` +
        `нод пересобрано ${rebuild.changed.length}`,
    );
    return {
      subscriptionId: subscription.id,
      subscriberId: subscription.subscriberId,
      status: subscription.status,
      expireAt: subscription.expireAt,
      subscriptionUrl: `https://${this.cfg.subPublicHost}/auto/${subscription.shortUuid}`,
    };
  }

  private async createManualSubscriber(label: string, grant: Grant) {
    return this.db.transaction(async (tx) => {
      const [person] = await tx
        .insert(schema.subscriber)
        .values({ orgId: this.cfg.defaultOrgId, description: label, status: "active" })
        .returning();
      const [created] = await tx
        .insert(schema.subscription)
        .values({
          orgId: this.cfg.defaultOrgId,
          subscriberId: person.id,
          shortUuid: generateShortUuid(),
          vlessUuid: randomUUID(),
          status: "active",
          expireAt: grant.days === null ? null : new Date(Date.now() + grant.days * 86_400_000),
          hwidDeviceLimit: grant.deviceLimit ?? null,
          trafficLimitBytes: grant.trafficGb ? grant.trafficGb * 1024 ** 3 : null,
        })
        .returning();
      if (grant.squadIds.length > 0) {
        await tx
          .insert(schema.subscriptionSquad)
          .values(grant.squadIds.map((squadId) => ({ subscriptionId: created.id, squadId })))
          .onConflictDoNothing();
      }
      return created;
    });
  }

  private async grantToSubscriber(subscriberId: string, grant: Grant) {
    await this.getById(subscriberId);
    const primary = await this.ensureSubscription(subscriberId);

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.subscription)
        .set({
          expireAt:
            grant.days === null
              ? null
              : sql`greatest(${schema.subscription.expireAt}, now()) + make_interval(days => ${grant.days}::int)`,
          status: statusAfterGrant,
          ...(grant.deviceLimit !== undefined ? { hwidDeviceLimit: grant.deviceLimit } : {}),
          ...(grant.trafficGb !== undefined
            ? { trafficLimitBytes: grant.trafficGb ? grant.trafficGb * 1024 ** 3 : null }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.subscription.id, primary.id), notForever(grant.days)))
        .returning();
      if (!row) throw new BadRequestException("подписка бессрочная — дни добавлять некуда");

      if (grant.squadIds.length > 0) {
        await tx
          .insert(schema.subscriptionSquad)
          .values(grant.squadIds.map((squadId) => ({ subscriptionId: row.id, squadId })))
          .onConflictDoNothing();
      }
      return row;
    });
  }

  /**
   * Продление из админки: от текущего окончания, если оно впереди, иначе от сегодня.
   * Одним UPDATE — без read-modify-write против параллельной оплаты, которая тоже
   * двигает срок. Бессрочную продлевать некуда.
   */
  async extend(subscriptionId: string, rawDays: unknown) {
    requireUuid(subscriptionId, "id");
    const days = grantDays(rawDays, false)!;
    await this.getSubscription(subscriptionId);

    const [row] = await this.db
      .update(schema.subscription)
      .set({
        expireAt: sql`greatest(${schema.subscription.expireAt}, now()) + make_interval(days => ${days}::int)`,
        status: statusAfterGrant,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          eq(schema.subscription.id, subscriptionId),
          notForever(days),
        ),
      )
      .returning();
    if (!row) throw new BadRequestException("подписка бессрочная — продлевать некуда");

    const rebuild = await this.nodes.rebuildAll();
    this.log.log(`подписка ${subscriptionId}: продлена на ${days} дн до ${row.expireAt?.toISOString()}, нод пересобрано ${rebuild.changed.length}`);
    return { subscriptionId, status: row.status, expireAt: row.expireAt };
  }

  /**
   * Отключение из админки — статус disabled: выдача отдаёт заглушку «приостановлена»,
   * с нод клиент уходит при пересборке. Включение снимает и disabled, и suspended
   * (приостановку за abuse снимают вручную — это она), а срок проверяет тут же, чтобы
   * истёкшая подписка не ожила как active. Повтор ничего не меняет.
   *
   * Неактивированную (inactive) не отключаем: включение сделало бы из неё active
   * без срока — бесплатный бессрочный доступ.
   */
  async setEnabled(subscriptionId: string, enabled: boolean) {
    requireUuid(subscriptionId, "id");
    const current = await this.getSubscription(subscriptionId);
    const scope = and(eq(schema.subscription.orgId, this.cfg.defaultOrgId), eq(schema.subscription.id, subscriptionId));

    const [row] = enabled
      ? await this.db
          .update(schema.subscription)
          .set({
            status: sql`case when ${schema.subscription.expireAt} is null or ${schema.subscription.expireAt} > now()
              then 'active' else 'expired' end`,
            updatedAt: new Date(),
          })
          .where(and(scope, inArray(schema.subscription.status, ["disabled", "suspended"])))
          .returning()
      : await this.db
          .update(schema.subscription)
          .set({ status: "disabled", updatedAt: new Date() })
          .where(and(scope, inArray(schema.subscription.status, ["active", "trial", "suspended", "expired"])))
          .returning();
    if (!row) return { subscriptionId, status: current.status, changed: false };

    const rebuild = await this.nodes.rebuildAll();
    this.log.warn(`подписка ${subscriptionId}: ${current.status} → ${row.status} из админки, нод пересобрано ${rebuild.changed.length}`);
    return { subscriptionId, status: row.status, changed: true };
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

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new BadRequestException(`${field}: ожидается uuid`);
  return value;
}

/** Срок выдачи в днях. null — бессрочно, если это допустимо (при продлении — нет). */
function grantDays(value: unknown, allowForever: boolean): number | null {
  if (value === null && allowForever) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_GRANT_DAYS) {
    throw new BadRequestException(`days: целое 1..${MAX_GRANT_DAYS}${allowForever ? " или null (бессрочно)" : ""}`);
  }
  return value;
}

/** Лимит: целое 1..max, null — без лимита, не прислан — не трогать. */
function optionalLimit(value: unknown, field: string, max: number): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new BadRequestException(`${field}: целое 1..${max} или null (без лимита)`);
  }
  return value;
}

/** Метка человека без бота: по ней его находят в списке подписчиков. */
function manualLabel(value: unknown): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (label.length === 0 || label.length > 128) {
    throw new BadRequestException("label: кто это — обязательная метка до 128 символов");
  }
  return label;
}

/**
 * Дни добавляются только к подписке со сроком. expire_at IS NULL у неактивированной
 * (inactive) — это «ещё не выдавали», а у остальных — бессрочная: к ней дни не прибавить.
 */
function notForever(days: number | null) {
  if (days === null) return undefined;
  return or(isNotNull(schema.subscription.expireAt), eq(schema.subscription.status, "inactive"));
}
