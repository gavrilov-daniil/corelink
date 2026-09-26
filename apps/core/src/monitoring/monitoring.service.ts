import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { buildProbeConfig } from "@corelink/xray-config";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { NodeStateService } from "../nodes/node-state.service.js";
import { SubscriptionRepository } from "../subscription/subscription.repository.js";
import { PROBE_EXECUTOR, ProbeInfraError, type ProbeExecutor, type ProbeOutcome } from "./probe-executor.js";

const DAY_MS = 86_400_000;

/**
 * Синтетическая проба сети: трафик через каждый канал — как у настоящего клиента.
 *
 * Heartbeat агента и «порт открыт» не видят ни сломанного Reality, ни блокировки: 26.09.2026
 * de1-exit числилась рабочей, пока Xray на ней лежал, а о том, что de-1 режет ТСПУ, узнали
 * от клиента. Проба смотрит глазами клиента и копит историю, а переходы «работал → упал»
 * и обратно пишет в ленту событий — пока это единственная доставка алертов (админка).
 *
 * Точка наблюдения dc — сам воркер. Из дата-центра блокировки ТСПУ не видны; для них —
 * точки home (устройство в РФ-сети), тот же учёт результатов.
 */
@Injectable()
export class MonitoringService {
  private readonly log = new Logger(MonitoringService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly repo: SubscriptionRepository,
    private readonly nodes: NodeStateService,
    @Inject(PROBE_EXECUTOR) private readonly execute: ProbeExecutor,
  ) {}

  private get org(): string {
    return this.cfg.defaultOrgId;
  }

  /**
   * Точка dc и её служебная подписка. Подписка — в каждом squad'е: проба обязана достать
   * любой канал, иначе канал своего squad'а числился бы упавшим. Идемпотентно; новая
   * подписка или членство — пересборка нод, иначе ноды пробу не пустят.
   */
  async ensureDcProbe() {
    const { probe, created } = await this.db.transaction(async (tx) => {
      // Та же блокировка, что у ensureSubscription: без неё два параллельных прогона
      // завели бы две служебные подписки, одна из которых осиротеет.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`monitor-probe-dc:${this.org}`}, 0))`);
      const [existing] = await tx
        .select()
        .from(schema.monitorProbe)
        .where(and(eq(schema.monitorProbe.orgId, this.org), eq(schema.monitorProbe.kind, "dc")))
        .limit(1);
      if (existing) return { probe: existing, created: false };

      const [person] = await tx
        .insert(schema.subscriber)
        .values({ orgId: this.org, description: "служебная: мониторинг из дата-центра", status: "active" })
        .returning();
      const [sub] = await tx
        .insert(schema.subscription)
        .values({
          orgId: this.org,
          subscriberId: person.id,
          shortUuid: randomBytes(12).toString("hex"),
          vlessUuid: randomUUID(),
          status: "active",
        })
        .returning();
      const [row] = await tx
        .insert(schema.monitorProbe)
        .values({ orgId: this.org, kind: "dc", name: "Дата-центр (платформа)", subscriptionId: sub.id })
        .returning();
      return { probe: row, created: true };
    });

    const squads = await this.db.select({ id: schema.squad.id }).from(schema.squad).where(eq(schema.squad.orgId, this.org));
    const joined =
      squads.length === 0
        ? []
        : await this.db
            .insert(schema.subscriptionSquad)
            .values(squads.map((s) => ({ subscriptionId: probe.subscriptionId, squadId: s.id })))
            .onConflictDoNothing()
            .returning();
    if (created || joined.length > 0) {
      const rebuild = await this.nodes.rebuildAll();
      this.log.log(`проба dc: доступ обновлён (squad'ов +${joined.length}), нод пересобрано ${rebuild.changed.length}`);
    }
    return probe;
  }

  /** Прогон пробы из дата-центра по всем каналам. Зовёт джоба node-probe — по расписанию и по кнопке в админке. */
  async runDcProbe() {
    const probe = await this.ensureDcProbe();
    const [subscription] = await this.db
      .select()
      .from(schema.subscription)
      .where(eq(schema.subscription.id, probe.subscriptionId))
      .limit(1);
    const { input, nodeByTag } = await this.repo.loadProbeInput(this.org, subscription!);
    // случайная база портов: ручной прогон может совпасть с плановым
    const { config, targets } = buildProbeConfig(input, 20_000 + Math.floor(Math.random() * 20_000));

    let outcomes: ProbeOutcome[];
    try {
      outcomes = await this.execute(config, targets);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(schema.monitorProbe)
        .set({ lastRunAt: new Date(), lastError: message.slice(0, 500) })
        .where(eq(schema.monitorProbe.id, probe.id));
      if (err instanceof ProbeInfraError) this.log.error(`проба dc не выполнилась: ${message}`);
      throw err;
    }

    const events = await this.recordResults(probe.id, outcomes, nodeByTag);
    await this.db
      .update(schema.monitorProbe)
      .set({ lastRunAt: new Date(), lastError: null })
      .where(eq(schema.monitorProbe.id, probe.id));
    const failed = outcomes.filter((o) => !o.ok).map((o) => o.tag);
    if (failed.length > 0) this.log.warn(`проба dc: не прошли ${failed.join(", ")}`);
    return { channels: outcomes.length, failed, events };
  }

  /**
   * Результаты прогона + переходы в ленту. Событие — только на смене состояния канала (и на
   * первом же провале нового канала): повторный провал ленту не засоряет.
   *
   * Под блокировкой пробы: плановый и ручной прогоны могут закончиться одновременно, и оба
   * увидели бы прежнее «работает» — в ленте вышло бы два одинаковых «упал».
   */
  async recordResults(probeId: string, outcomes: ProbeOutcome[], nodeByTag: Map<string, string | null>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`monitor-record:${probeId}`}, 0))`);
      let events = 0;
      for (const o of outcomes) {
        const [previous] = await tx
          .select({ ok: schema.probeResult.ok })
          .from(schema.probeResult)
          .where(and(eq(schema.probeResult.probeId, probeId), eq(schema.probeResult.channelTag, o.tag)))
          .orderBy(desc(schema.probeResult.checkedAt))
          .limit(1);
        const nodeId = nodeByTag.get(o.tag) ?? null;
        await tx.insert(schema.probeResult).values({
          orgId: this.org,
          probeId,
          channelTag: o.tag,
          nodeId,
          ok: o.ok,
          latencyMs: o.latencyMs,
          error: o.error,
        });

        const changed = previous ? previous.ok !== o.ok : !o.ok;
        if (!changed) continue;
        events++;
        await tx.insert(schema.monitorEvent).values({
          orgId: this.org,
          probeId,
          nodeId,
          channelTag: o.tag,
          kind: o.ok ? "probe_up" : "probe_down",
          message: o.ok ? `снова работает, ${o.latencyMs ?? "?"} мс` : (o.error ?? "нет ответа"),
        });
      }
      return events;
    });
  }

  /** Сводка для страницы «Мониторинг»: точки, последнее состояние каналов, доступность за сутки, лента. */
  async overview() {
    const since = new Date(Date.now() - DAY_MS);
    const probes = await this.db
      .select({
        id: schema.monitorProbe.id,
        kind: schema.monitorProbe.kind,
        name: schema.monitorProbe.name,
        lastRunAt: schema.monitorProbe.lastRunAt,
        lastError: schema.monitorProbe.lastError,
      })
      .from(schema.monitorProbe)
      .where(eq(schema.monitorProbe.orgId, this.org));

    const latest = await this.db
      .selectDistinctOn([schema.probeResult.probeId, schema.probeResult.channelTag], {
        probeId: schema.probeResult.probeId,
        channelTag: schema.probeResult.channelTag,
        nodeId: schema.probeResult.nodeId,
        ok: schema.probeResult.ok,
        latencyMs: schema.probeResult.latencyMs,
        error: schema.probeResult.error,
        checkedAt: schema.probeResult.checkedAt,
      })
      .from(schema.probeResult)
      .where(eq(schema.probeResult.orgId, this.org))
      .orderBy(schema.probeResult.probeId, schema.probeResult.channelTag, desc(schema.probeResult.checkedAt));

    const uptime = await this.db
      .select({
        probeId: schema.probeResult.probeId,
        channelTag: schema.probeResult.channelTag,
        checks: sql<number>`count(*)::int`,
        passed: sql<number>`count(*) filter (where ${schema.probeResult.ok})::int`,
      })
      .from(schema.probeResult)
      .where(and(eq(schema.probeResult.orgId, this.org), gte(schema.probeResult.checkedAt, since)))
      .groupBy(schema.probeResult.probeId, schema.probeResult.channelTag);
    const uptimeKey = (probeId: string, tag: string) => `${probeId}\u0000${tag}`;
    const uptimeBy = new Map(uptime.map((u) => [uptimeKey(u.probeId, u.channelTag), u]));

    const nodes = await this.db
      .select({
        id: schema.node.id,
        name: schema.node.name,
        country: schema.server.country,
        heartbeatAt: schema.nodeReportedState.heartbeatAt,
        xrayError: schema.nodeReportedState.xrayError,
      })
      .from(schema.node)
      .leftJoin(schema.server, eq(schema.server.id, schema.node.serverId))
      .leftJoin(schema.nodeReportedState, eq(schema.nodeReportedState.nodeId, schema.node.id))
      .where(eq(schema.node.orgId, this.org));

    const events = await this.db
      .select({
        id: schema.monitorEvent.id,
        kind: schema.monitorEvent.kind,
        probeId: schema.monitorEvent.probeId,
        nodeId: schema.monitorEvent.nodeId,
        channelTag: schema.monitorEvent.channelTag,
        message: schema.monitorEvent.message,
        createdAt: schema.monitorEvent.createdAt,
      })
      .from(schema.monitorEvent)
      .where(eq(schema.monitorEvent.orgId, this.org))
      .orderBy(desc(schema.monitorEvent.createdAt))
      .limit(50);

    return {
      probes,
      nodes,
      channels: latest.map((l) => {
        const u = uptimeBy.get(uptimeKey(l.probeId, l.channelTag));
        return { ...l, checks24h: u?.checks ?? 0, passed24h: u?.passed ?? 0 };
      }),
      events,
    };
  }

  /** Чистка: результаты копятся по строке на канал каждые 5 минут — хранить вечно незачем. */
  async purge(resultDays = 14, eventDays = 90) {
    const results = await this.db
      .delete(schema.probeResult)
      .where(lt(schema.probeResult.checkedAt, new Date(Date.now() - resultDays * DAY_MS)))
      .returning({ id: schema.probeResult.id });
    const events = await this.db
      .delete(schema.monitorEvent)
      .where(lt(schema.monitorEvent.createdAt, new Date(Date.now() - eventDays * DAY_MS)))
      .returning({ id: schema.monitorEvent.id });
    return { results: results.length, events: events.length };
  }
}
