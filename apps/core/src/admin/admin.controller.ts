import { Controller, Get, Inject } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { MinRole } from "../auth/roles.js";
import { loadConfig } from "../config.js";

@Controller("api/admin")
export class AdminController {
  private readonly cfg = loadConfig();
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Ноды со сходимостью: desired-хеш против применённого агентом.
   * `converged=false` означает, что нода ещё не приняла последний конфиг —
   * именно это состояние нужно видеть оператору, а не просто «активна».
   */
  @Get("nodes")
  async nodes() {
    const rows = await this.db
      .select({
        node: schema.node,
        server: schema.server,
        desired: schema.nodeDesiredState,
        reported: schema.nodeReportedState,
      })
      .from(schema.node)
      .leftJoin(schema.server, eq(schema.node.serverId, schema.server.id))
      .leftJoin(schema.nodeDesiredState, eq(schema.nodeDesiredState.nodeId, schema.node.id))
      .leftJoin(schema.nodeReportedState, eq(schema.nodeReportedState.nodeId, schema.node.id))
      .where(eq(schema.node.orgId, this.cfg.defaultOrgId));

    return rows.map(({ node, server, desired, reported }) => ({
      id: node.id,
      name: node.name,
      roles: node.roles,
      status: node.status,
      // поля правки: форма редактирования ноды берёт текущие значения отсюда,
      // отдельного GET nodes/:id ради этого заводить незачем
      serverId: node.serverId,
      serverHostname: server?.hostname ?? null,
      configProfileId: node.configProfileId,
      consumptionMultiplier: node.consumptionMultiplier,
      trackTraffic: node.trackTraffic,
      sortOrder: node.sortOrder,
      address: server?.primaryIp ?? null,
      country: server?.country ?? null,
      lastHeartbeatAt: server?.lastHeartbeatAt ?? null,
      agentVersion: reported?.agentVersion ?? null,
      xrayVersion: reported?.xrayVersion ?? null,
      desiredVersion: desired?.version ?? null,
      desiredConfigHash: desired?.configHash ?? null,
      appliedConfigHash: reported?.appliedConfigHash ?? null,
      converged: Boolean(desired && reported && desired.configHash === reported.appliedConfigHash),
    }));
  }

  /**
   * Подписчики: shortUuid нужен, чтобы связать строку с расходом трафика.
   * Саппорту доступно на чтение — без состояния подписки он не ответит клиенту.
   */
  @Get("subscribers")
  @MinRole("support")
  async subscribers() {
    const rows = await this.db
      .select({
        sub: schema.subscription,
        s: schema.subscriber,
        devices: sql<string>`(
          select count(*) from ${schema.subscriberDevice}
          where ${schema.subscriberDevice.subscriptionId} = ${schema.subscription.id}
        )`,
        balance: sql<string>`(
          select coalesce(sum(${schema.ledgerEntry.amountKopeks}), 0) from ${schema.ledgerEntry}
          where ${schema.ledgerEntry.subscriberId} = ${schema.subscription.subscriberId}
        )`,
      })
      .from(schema.subscription)
      .leftJoin(schema.subscriber, eq(schema.subscription.subscriberId, schema.subscriber.id))
      .where(eq(schema.subscription.orgId, this.cfg.defaultOrgId));

    return rows.map(({ sub, s, devices, balance }) => ({
      id: sub.id,
      subscriberId: sub.subscriberId,
      shortUuid: sub.shortUuid,
      // ручная выдача отдаёт ссылку оператору — без неё человеку без бота её не передать
      subscriptionUrl: `https://${this.cfg.subPublicHost}/auto/${sub.shortUuid}`,
      username: s?.username ?? null,
      telegramId: s?.telegramId ?? null,
      // метка человека без бота (ручная выдача): кроме неё его в списке не опознать
      label: s?.description ?? null,
      status: sub.status,
      expireAt: sub.expireAt,
      usedTrafficBytes: Number(sub.usedTrafficBytes ?? 0),
      trafficLimitBytes: sub.trafficLimitBytes ? Number(sub.trafficLimitBytes) : null,
      deviceLimit: sub.hwidDeviceLimit,
      devicesUsed: Number(devices ?? 0),
      balanceKopeks: Number(balance ?? 0),
      onlineAt: sub.onlineAt,
      // отметки выдачи: видно, ходит ли клиент за конфигом и чем именно
      lastOpenedAt: sub.subLastOpenedAt,
      lastUserAgent: sub.subLastUserAgent,
      revokedAt: sub.subRevokedAt,
      createdAt: sub.createdAt,
    }));
  }

  /** Сегменты — для выбора аудитории рассылки без ручного ввода uuid. */
  @Get("segments")
  async segments() {
    return this.db
      .select()
      .from(schema.segment)
      .where(eq(schema.segment.orgId, this.cfg.defaultOrgId));
  }

  /** Платежи — лента для сверки и разбора инцидентов. */
  @Get("payments")
  async payments() {
    const rows = await this.db
      .select({ p: schema.payment, s: schema.subscriber })
      .from(schema.payment)
      .leftJoin(schema.subscriber, eq(schema.payment.subscriberId, schema.subscriber.id))
      .where(eq(schema.payment.orgId, this.cfg.defaultOrgId))
      .orderBy(sql`${schema.payment.createdAt} desc`)
      .limit(200);

    return rows.map(({ p, s }) => ({
      id: p.id,
      provider: p.provider,
      providerPaymentId: p.providerPaymentId,
      purpose: p.purpose,
      amountKopeks: Number(p.amountKopeks),
      currency: p.currency,
      status: p.status,
      username: s?.username ?? null,
      telegramId: s?.telegramId ?? null,
      createdAt: p.createdAt,
      paidAt: p.paidAt,
    }));
  }
}
