import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { NodeStateService } from "./node-state.service.js";

/**
 * Скрещивание нод в каскады.
 *
 * server_forward — цепочка собирается на relay: раскатывается на ОБЕ ноды
 *   (link-user на exit + outbound CASCADE_<CC> и правило на relay).
 * client_chain  — на ноды не раскатывается вовсе: цепочку собирает клиентский
 *   конфиг через sockopt.dialerProxy (см. генератор подписки).
 *
 * Канал попадает в подписку ТОЛЬКО в статусе active — то есть когда обе ноды
 * отчитались, что применили нужную версию. Иначе клиент получил бы полу-собранный
 * каскад и его трафик уходил бы в никуда.
 */
@Injectable()
export class CascadeService {
  private readonly log = new Logger(CascadeService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly state: NodeStateService,
  ) {}

  async link(input: {
    kind: "server_forward" | "client_chain";
    cc: string;
    exitNodeId: string;
    exitInboundTag: string;
    relayNodeId?: string;
    frontNodeId?: string;
  }) {
    const [row] = await this.db
      .insert(schema.cascadeLink)
      .values({
        orgId: this.cfg.defaultOrgId,
        kind: input.kind,
        cc: input.cc.toUpperCase(),
        exitNodeId: input.exitNodeId,
        exitInboundTag: input.exitInboundTag,
        relayNodeId: input.relayNodeId,
        frontNodeId: input.frontNodeId,
        linkUserUuid: "00000000-0000-0000-0000-000000000000", // заменяется ниже детерминированным
        status: "planned",
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      this.log.warn(`каскад ${input.cc} relay=${input.relayNodeId} exit=${input.exitNodeId} уже существует`);
      return this.find(input.relayNodeId, input.exitNodeId, input.cc);
    }

    // uuid служебного пользователя выводится из id связи — повторная раскатка
    // не создаст второго link-user'а на exit'е
    const linkUserUuid = NodeStateService.linkUserUuid(row.id);
    const [updated] = await this.db
      .update(schema.cascadeLink)
      .set({ linkUserUuid })
      .where(eq(schema.cascadeLink.id, row.id))
      .returning();

    if (input.kind === "server_forward") await this.deploy(updated);
    else await this.db.update(schema.cascadeLink).set({ status: "active" }).where(eq(schema.cascadeLink.id, row.id));

    return updated;
  }

  /** Раскатка на обе ноды: сначала exit (link-user), затем relay (outbound+правило). */
  async deploy(link: typeof schema.cascadeLink.$inferSelect) {
    await this.state.rebuild(link.exitNodeId);
    if (link.relayNodeId) await this.state.rebuild(link.relayNodeId);
    await this.refreshStatus(link.id);
  }

  /**
   * Статус — НЕПРЕРЫВНАЯ функция от reported-state обеих нод, а не одноразовая защёлка.
   * Если позже одно плечо разъедется (нода откатилась/переналита), канал должен
   * автоматически уйти из подписки, а не остаться «навсегда active».
   */
  async refreshStatus(cascadeLinkId: string) {
    const [link] = await this.db
      .select()
      .from(schema.cascadeLink)
      .where(eq(schema.cascadeLink.id, cascadeLinkId))
      .limit(1);
    if (!link) return null;
    if (link.kind === "client_chain") return link;

    const exitOk = await this.isConverged(link.exitNodeId);
    const relayOk = link.relayNodeId ? await this.isConverged(link.relayNodeId) : false;

    const status = exitOk && relayOk ? "active" : exitOk ? "exit_ready" : "planned";
    // вызов идёт с частотой heartbeat'а агента — без изменения статуса не пишем в БД
    if (status === link.status) return link;

    const [updated] = await this.db
      .update(schema.cascadeLink)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.cascadeLink.id, cascadeLinkId))
      .returning();

    this.log.log(`каскад ${link.cc}: ${link.status} → ${status}`);
    return updated;
  }

  /**
   * Пересчёт статуса всех каскадов, где нода — одно из плеч. Зовётся после отчёта агента:
   * именно сходимость ноды по config_hash переводит канал в active и обратно.
   */
  async refreshForNode(nodeId: string): Promise<number> {
    const links = await this.db
      .select({ id: schema.cascadeLink.id })
      .from(schema.cascadeLink)
      .where(
        and(
          eq(schema.cascadeLink.orgId, this.cfg.defaultOrgId),
          or(eq(schema.cascadeLink.exitNodeId, nodeId), eq(schema.cascadeLink.relayNodeId, nodeId)),
        ),
      );

    for (const link of links) await this.refreshStatus(link.id);
    return links.length;
  }

  /**
   * Нода сошлась, если применённый hash совпадает с желаемым и Xray на ней работает:
   * иначе каскад через ноду с лежащим Xray раздавался бы клиентам как рабочий.
   */
  private async isConverged(nodeId: string): Promise<boolean> {
    const [desired] = await this.db
      .select()
      .from(schema.nodeDesiredState)
      .where(eq(schema.nodeDesiredState.nodeId, nodeId))
      .limit(1);
    const [reported] = await this.db
      .select()
      .from(schema.nodeReportedState)
      .where(eq(schema.nodeReportedState.nodeId, nodeId))
      .limit(1);
    return Boolean(desired && reported && desired.configHash === reported.appliedConfigHash && !reported.xrayError);
  }

  /**
   * Привязка канала подписки к каскаду. Без неё выдача не знает, что канал
   * каскадный, и раздаёт его клиентам независимо от готовности плеч.
   */
  async attachChannel(cascadeLinkId: string, channelId: string) {
    const [row] = await this.db
      .update(schema.channel)
      .set({ cascadeLinkId })
      .where(and(eq(schema.channel.orgId, this.cfg.defaultOrgId), eq(schema.channel.id, channelId)))
      .returning();
    return row ?? null;
  }

  /** Каналы, которые можно показывать в подписке. */
  async listActive() {
    return this.db
      .select()
      .from(schema.cascadeLink)
      .where(and(eq(schema.cascadeLink.orgId, this.cfg.defaultOrgId), eq(schema.cascadeLink.status, "active")));
  }

  async list() {
    return this.db
      .select()
      .from(schema.cascadeLink)
      .where(eq(schema.cascadeLink.orgId, this.cfg.defaultOrgId));
  }

  private async find(relayNodeId: string | undefined, exitNodeId: string, cc: string) {
    const [row] = await this.db
      .select()
      .from(schema.cascadeLink)
      .where(
        and(
          eq(schema.cascadeLink.orgId, this.cfg.defaultOrgId),
          eq(schema.cascadeLink.exitNodeId, exitNodeId),
          eq(schema.cascadeLink.cc, cc.toUpperCase()),
          relayNodeId ? eq(schema.cascadeLink.relayNodeId, relayNodeId) : undefined,
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
