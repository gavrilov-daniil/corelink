import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import {
  buildNodeConfig,
  configHash,
  deterministicUuid,
  type CascadeOutbound,
  type NodeInbound,
  type NodeUser,
} from "@corelink/xray-config";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

const CASCADE_UUID_NS = "gavy-vpn-cascade";

/**
 * Сборка desired-state ноды из модели БД.
 * Генератор детерминирован: повторная сборка без изменений даёт тот же config_hash,
 * агент видит совпадение и не трогает Xray (no-op вместо лишнего рестарта).
 */
@Injectable()
export class NodeStateService {
  private readonly log = new Logger(NodeStateService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  /** Пересобирает desired-state и повышает версию, только если конфиг реально изменился. */
  async rebuild(nodeId: string) {
    const node = await this.getNode(nodeId);

    const inboundRows = await this.db
      .select()
      .from(schema.inbound)
      .where(eq(schema.inbound.configProfileId, node.configProfileId));

    const inbounds: NodeInbound[] = inboundRows.map((i) => {
      const params = (i.params ?? {}) as { serviceName?: string; path?: string; host?: string };
      return {
        tag: i.tag,
        port: i.port,
        role: (node.roles[0] ?? "exit") as NodeInbound["role"],
        flow: i.flow,
        network: i.network,
        security: i.security,
        ...(params.serviceName ? { serviceName: params.serviceName } : {}),
        ...(params.path ? { path: params.path } : {}),
        ...(params.host ? { host: params.host } : {}),
        reality: {
          publicKey: i.realityPublicKey ?? "",
          shortIds: i.shortIds.length > 0 ? i.shortIds : [""],
          sni: i.sni ?? "",
          fingerprint: i.fingerprint ?? "firefox",
        },
      };
    });

    const users = await this.collectUsers(node, inboundRows);
    const cascades = await this.collectCascades(nodeId, inboundRows);

    const config = buildNodeConfig({
      role: (node.roles[0] ?? "exit") as NodeInbound["role"],
      inbounds,
      users,
      cascades,
    });
    const hash = configHash(config);

    const [existing] = await this.db
      .select()
      .from(schema.nodeDesiredState)
      .where(eq(schema.nodeDesiredState.nodeId, nodeId))
      .limit(1);

    if (existing?.configHash === hash) return { changed: false, version: existing.version, hash };

    // плоский список для агента: inboundTag здесь теряется, поэтому схлопываем по uuid —
    // иначе юзер, состоящий в двух squad'ах, приезжает агенту N раз
    const flatUsers = [
      ...new Map(users.map((u) => [u.uuid, { email: u.email, uuid: u.uuid, level: u.level ?? 0 }])).values(),
    ];

    // upsert, а не select+insert/update: ноду параллельно пересобирают api и воркер,
    // read-modify-write давал 23505 и терял версию. Версия растёт в SQL, а setWhere
    // гасит вторую запись того же конфига — версия не скачет вхолостую.
    const [written] = await this.db
      .insert(schema.nodeDesiredState)
      .values({ nodeId, version: 1, configHash: hash, config, users: flatUsers, generatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.nodeDesiredState.nodeId,
        set: {
          version: sql`${schema.nodeDesiredState.version} + 1`,
          configHash: hash,
          config,
          users: flatUsers,
          generatedAt: new Date(),
        },
        setWhere: ne(schema.nodeDesiredState.configHash, hash),
      })
      .returning({ version: schema.nodeDesiredState.version });

    if (!written) {
      // конкурент записал тот же конфиг между проверкой и upsert — состояние уже актуально
      const current = await this.loadState(nodeId);
      return { changed: false, version: current?.version ?? 0, hash };
    }

    // greatest: параллельный rebuild мог записать версию выше, откатывать её нельзя
    await this.db
      .update(schema.node)
      .set({ desiredConfigVersion: sql`greatest(${schema.node.desiredConfigVersion}, ${written.version})` })
      .where(eq(schema.node.id, nodeId));

    this.log.log(`node ${node.name}: desired-state v${written.version} (${hash.slice(0, 12)})`);
    return { changed: true, version: written.version, hash };
  }

  /**
   * Пересборка всех нод org. Дёшево: rebuild не поднимает версию, если конфиг не изменился,
   * поэтому это безопасно гонять по расписанию как safety-net.
   */
  async rebuildAll(): Promise<{ total: number; changed: string[]; failed: string[] }> {
    const nodes = await this.db
      .select({ id: schema.node.id, name: schema.node.name })
      .from(schema.node)
      .where(eq(schema.node.orgId, this.cfg.defaultOrgId));

    const changed: string[] = [];
    const failed: string[] = [];
    for (const n of nodes) {
      try {
        const result = await this.rebuild(n.id);
        if (result.changed) changed.push(n.id);
      } catch (err) {
        failed.push(n.id);
        this.log.error(`node ${n.name}: пересборка не удалась — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { total: nodes.length, changed, failed };
  }

  async getDesiredState(nodeId: string): Promise<typeof schema.nodeDesiredState.$inferSelect> {
    const existing = await this.loadState(nodeId);
    if (existing) return existing;

    // первый запрос агента после регистрации — состояния ещё нет, собираем на лету
    await this.rebuild(nodeId);
    const built = await this.loadState(nodeId);
    if (!built) throw new NotFoundException(`не удалось собрать desired-state для ноды ${nodeId}`);
    return built;
  }

  private async loadState(nodeId: string) {
    const [state] = await this.db
      .select()
      .from(schema.nodeDesiredState)
      .where(eq(schema.nodeDesiredState.nodeId, nodeId))
      .limit(1);
    return state ?? null;
  }

  /**
   * Отчёт агента: что реально применено.
   * Пересчёт статуса каскадов идёт следом, в AgentController (CascadeService.refreshForNode):
   * тянуть CascadeService сюда нельзя — кольцо NodeStateService↔CascadeService падает
   * на старте (design:paramtypes читает класс из ещё не инициализированного ESM-модуля),
   * а forwardRef с emitDecoratorMetadata это не лечит.
   */
  async report(
    nodeId: string,
    input: { appliedConfigHash?: string; agentVersion?: string; xrayVersion?: string; sysStats?: Record<string, unknown>; egressHealth?: Record<string, unknown> },
  ) {
    const reported = {
      appliedConfigHash: input.appliedConfigHash,
      agentVersion: input.agentVersion,
      xrayVersion: input.xrayVersion,
      sysStats: input.sysStats ?? {},
      egressHealth: input.egressHealth ?? {},
      heartbeatAt: new Date(),
    };

    // upsert: два отчёта агента подряд (или отчёт на фоне первой регистрации) не должны
    // ловить 23505 на select+insert
    await this.db
      .insert(schema.nodeReportedState)
      .values({ nodeId, ...reported })
      .onConflictDoUpdate({ target: schema.nodeReportedState.nodeId, set: reported });

    await this.db
      .update(schema.node)
      .set({ observedConfigHash: input.appliedConfigHash ?? null, status: "active" })
      .where(eq(schema.node.id, nodeId));

    const node = await this.getNode(nodeId);
    await this.db
      .update(schema.server)
      .set({
        lastHeartbeatAt: new Date(),
        agentStatus: "online",
        agentVersion: input.agentVersion,
        xrayVersion: input.xrayVersion,
      })
      .where(eq(schema.server.id, node.serverId));

    return { ok: true };
  }

  /** Пользователи ноды: обычные подписчики через squad + служебные link-user каскадов. */
  private async collectUsers(
    node: typeof schema.node.$inferSelect,
    inboundRows: Array<typeof schema.inbound.$inferSelect>,
  ): Promise<NodeUser[]> {
    const inboundIds = inboundRows.map((i) => i.id);
    if (inboundIds.length === 0) return [];

    const squadLinks = await this.db
      .select({
        squadId: schema.squadInbound.squadId,
        inboundId: schema.squadInbound.inboundId,
        forAll: schema.squad.forAll,
      })
      .from(schema.squadInbound)
      .innerJoin(schema.squad, eq(schema.squad.id, schema.squadInbound.squadId))
      .where(inArray(schema.squadInbound.inboundId, inboundIds));

    const users: NodeUser[] = [];
    if (squadLinks.length > 0) {
      const squadIds = [...new Set(squadLinks.map((s) => s.squadId))];
      // squadId тянем вместе с подпиской: без него получалось декартово произведение —
      // подписка squad'а A уезжала на inbound'ы squad'а B (squad переставал быть
      // access-control), а членство в двух squad'ах давало двух клиентов с одинаковым
      // email/uuid в одном inbound → Xray не стартует («User already exists»)
      const subs = await this.db
        .select({ sub: schema.subscription, squadId: schema.subscriptionSquad.squadId })
        .from(schema.subscriptionSquad)
        .innerJoin(schema.subscription, eq(schema.subscriptionSquad.subscriptionId, schema.subscription.id))
        .where(inArray(schema.subscriptionSquad.squadId, squadIds));

      // общий squad: в нём каждая подписка org, строк subscription_squad у него нет.
      // Неактивных отсекаем ещё в SQL — их может быть больше, чем живых.
      const generalIds = [...new Set(squadLinks.filter((s) => s.forAll).map((s) => s.squadId))];
      if (generalIds.length > 0) {
        const everyone = await this.db
          .select()
          .from(schema.subscription)
          .where(
            and(
              eq(schema.subscription.orgId, node.orgId),
              inArray(schema.subscription.status, ["active", "trial"]),
              or(isNull(schema.subscription.expireAt), gte(schema.subscription.expireAt, new Date())),
            ),
          );
        for (const sub of everyone) for (const squadId of generalIds) subs.push({ sub, squadId });
      }

      const inboundById = new Map(inboundRows.map((i) => [i.id, i]));
      const inboundsBySquad = new Map<string, Array<typeof schema.inbound.$inferSelect>>();
      for (const link of squadLinks) {
        const inbound = inboundById.get(link.inboundId);
        if (!inbound) continue;
        const list = inboundsBySquad.get(link.squadId);
        if (list) list.push(inbound);
        else inboundsBySquad.set(link.squadId, [inbound]);
      }

      for (const { sub, squadId } of subs) {
        // истёкшие и отключённые на ноду не выгружаются — это и есть отключение доступа
        if (sub.status !== "active" && sub.status !== "trial") continue;
        if (sub.expireAt && sub.expireAt < new Date()) continue;
        for (const inbound of inboundsBySquad.get(squadId) ?? []) {
          users.push({ email: sub.shortUuid, uuid: sub.vlessUuid, inboundTag: inbound.tag });
        }
      }
    }

    // link-user'ы: relay представлен на exit'е служебным аккаунтом
    const links = await this.db
      .select()
      .from(schema.cascadeLink)
      .where(and(eq(schema.cascadeLink.orgId, this.cfg.defaultOrgId), eq(schema.cascadeLink.exitNodeId, node.id)));

    for (const link of links) {
      const inbound = inboundRows.find((i) => i.tag === link.exitInboundTag);
      if (!inbound) continue;
      users.push({
        email: `cascade:${link.cc.toLowerCase()}:${link.id.slice(0, 8)}`,
        uuid: link.linkUserUuid,
        inboundTag: inbound.tag,
      });
    }

    return dedupeUsers(users);
  }

  /** Плечо каскада на стороне relay: outbound на exit + правило форварда. */
  private async collectCascades(
    nodeId: string,
    inboundRows: Array<typeof schema.inbound.$inferSelect>,
  ): Promise<CascadeOutbound[]> {
    const links = await this.db
      .select()
      .from(schema.cascadeLink)
      .where(
        and(
          eq(schema.cascadeLink.orgId, this.cfg.defaultOrgId),
          eq(schema.cascadeLink.relayNodeId, nodeId),
          eq(schema.cascadeLink.kind, "server_forward"),
        ),
      );

    const out: CascadeOutbound[] = [];
    for (const link of links) {
      const [exitHost] = await this.db
        .select({ host: schema.host, inbound: schema.inbound })
        .from(schema.host)
        .innerJoin(schema.inbound, eq(schema.host.inboundId, schema.inbound.id))
        .where(and(eq(schema.host.nodeId, link.exitNodeId), eq(schema.inbound.tag, link.exitInboundTag)))
        .limit(1);
      if (!exitHost) continue;

      const relayInbound = inboundRows[0];
      if (!relayInbound) continue;

      out.push({
        tag: `CASCADE_${link.cc.toUpperCase()}`,
        cc: link.cc,
        fromInboundTag: relayInbound.tag,
        exit: {
          address: exitHost.host.address,
          port: exitHost.host.port,
          uuid: link.linkUserUuid,
          flow: exitHost.host.flow ?? "xtls-rprx-vision",
          reality: {
            publicKey: exitHost.host.pbk ?? "",
            shortIds: [exitHost.host.sid ?? ""],
            sni: exitHost.host.sni ?? "",
            fingerprint: exitHost.host.fingerprint ?? "firefox",
          },
        },
      });
    }
    return out;
  }

  /** Детерминированный uuid служебного пользователя каскада. */
  static linkUserUuid(cascadeLinkId: string): string {
    return deterministicUuid(CASCADE_UUID_NS, cascadeLinkId);
  }

  private async getNode(nodeId: string) {
    const [node] = await this.db
      .select()
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.cfg.defaultOrgId), eq(schema.node.id, nodeId)))
      .limit(1);
    if (!node) throw new NotFoundException(`нода ${nodeId} не найдена`);
    return node;
  }
}

/**
 * Один клиент на inbound: пара (inboundTag, uuid) — это и есть ключ Xray, дубль валит старт.
 * Сортировка обязательна: порядок строк из БД не гарантирован, а от порядка зависит config_hash
 * (разъехавшийся hash = бесконечный рестарт Xray на каждой пересборке).
 */
function dedupeUsers(users: NodeUser[]): NodeUser[] {
  const byKey = new Map<string, NodeUser>();
  for (const u of users) {
    const key = `${u.inboundTag}\u0000${u.uuid}`;
    if (!byKey.has(key)) byKey.set(key, u);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.inboundTag.localeCompare(b.inboundTag) || a.email.localeCompare(b.email) || a.uuid.localeCompare(b.uuid),
  );
}
