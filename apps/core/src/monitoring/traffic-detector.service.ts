import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

const SLOT_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** Слот закрыт, когда агенты успели прислать его окна: окно — 30 с, плюс задержка отправки. */
const REPORT_LAG_MS = 2 * 60_000;
const BASELINE_DAYS = 7;
/** Меньше трёх дней истории — «обычное для этого часа» ещё не известно. */
const MIN_BASELINE_DAYS = 3;
/** Активный клиент — от 64 КБ за слот: застрявшие рукопожатия и keepalive активностью не считаются. */
const ACTIVE_BYTES = 64 * 1024;
/** Нода на связи: heartbeat свежее 3 минут и Xray работает. Иначе о ней скажут проба и heartbeat. */
const ALIVE_MS = 3 * 60_000;
/** Гистерезис: «пропали» — ниже порога падения, «вернулись» — от половины обычного. */
const RESTORE_RATIO = 0.5;

const NODE_KINDS = ["traffic_drop", "traffic_restore"];
const NETWORK_KINDS = ["network_traffic_drop", "network_traffic_restore"];

export type TrafficSkip = "disabled" | "offline" | "no_stats" | "no_history" | "few_clients";
export type TrafficVerdict = "drop" | "ok" | null;
/** Два последних закрытых слота: старший и младший. */
type Pair = [number, number];

export interface NodeTraffic {
  nodeId: string;
  name: string;
  /** Почему нода не оценивается; null — оценивается. */
  skipped: TrafficSkip | null;
  /** Активных клиентов в двух последних слотах; null — агент их не прислал. */
  now: Pair | null;
  /** Обычно в эти слоты — медиана за неделю; null — истории меньше трёх дней. */
  usual: Pair | null;
  /** drop/ok — оба слота согласны; null — переходное состояние или нода не оценивается. */
  verdict: TrafficVerdict;
}

export interface TrafficEvaluation {
  slotEnd: Date;
  minUsers: number;
  dropPct: number;
  nodes: NodeTraffic[];
  network: { now: Pair; usual: Pair; verdict: TrafficVerdict; evaluated: number };
}

/**
 * Детектор по трафику настоящих клиентов: проба видит одну точку наблюдения, а здесь видно,
 * что клиенты перестали ходить через ноду — блокировка для РФ-сетей, которую из дата-центра
 * не увидеть, или уход клиентов: балансировщики в их конфигах сами переключают на другие ноды.
 *
 * Мера — активные клиенты за 5-минутный слот против обычного для этого часа (медиана того же
 * слота за неделю). Считается только пользовательский трафик: inbound `api` — опросы статистики
 * самим агентом, служебные подписки проб — трафик мониторинга. Решение — по двум слотам подряд;
 * если просела вся сеть — одно событие по сети, а не по каждой ноде.
 */
@Injectable()
export class TrafficDetectorService {
  private readonly log = new Logger(TrafficDetectorService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  private get org(): string {
    return this.cfg.defaultOrgId;
  }

  async evaluate(now = new Date()): Promise<TrafficEvaluation> {
    const minUsers = Math.max(this.cfg.trafficDetectMinUsers, 1);
    const dropPct = this.cfg.trafficDetectDropPct;
    const slotEnd = new Date(Math.floor((now.getTime() - REPORT_LAG_MS) / SLOT_MS) * SLOT_MS);
    const slots: Pair = [slotEnd.getTime() - 2 * SLOT_MS, slotEnd.getTime() - SLOT_MS];
    const pastDays = Array.from({ length: BASELINE_DAYS }, (_, i) => i + 1);

    const active = await this.activeBySlot(slots.flatMap((s) => [s, ...pastDays.map((d) => s - d * DAY_MS)]));
    const at = (nodeId: string, slot: number) => active.get(`${nodeId}|${slot}`);

    const nodes = await this.db
      .select({
        id: schema.node.id,
        name: schema.node.name,
        heartbeatAt: schema.nodeReportedState.heartbeatAt,
        xrayError: schema.nodeReportedState.xrayError,
      })
      .from(schema.node)
      .leftJoin(schema.nodeReportedState, eq(schema.nodeReportedState.nodeId, schema.node.id))
      .where(eq(schema.node.orgId, this.org))
      .orderBy(schema.node.name);

    const statuses: NodeTraffic[] = nodes.map((n) => {
      const current = slots.map((s) => at(n.id, s));
      const history = slots.map((s) => pastDays.map((d) => at(n.id, s - d * DAY_MS)).filter((v) => v !== undefined));
      const status: NodeTraffic = {
        nodeId: n.id,
        name: n.name,
        skipped: null,
        now: current[0] !== undefined && current[1] !== undefined ? [current[0], current[1]] : null,
        usual: history.every((h) => h.length >= MIN_BASELINE_DAYS) ? [median(history[0]!), median(history[1]!)] : null,
        verdict: null,
      };
      const alive = n.heartbeatAt && now.getTime() - n.heartbeatAt.getTime() <= ALIVE_MS && !n.xrayError;
      if (dropPct === 0) status.skipped = "disabled";
      else if (!alive) status.skipped = "offline";
      else if (!status.now) status.skipped = "no_stats";
      else if (!status.usual) status.skipped = "no_history";
      else if (Math.min(...status.usual) < minUsers) status.skipped = "few_clients";
      return status;
    });

    const low = 1 - dropPct / 100;
    const judged = statuses.filter((s) => s.skipped === null);
    const total = (k: 0 | 1, of: "now" | "usual") => judged.reduce((sum, s) => sum + s[of]![k], 0);
    const ratio = (current: number, usual: number) => (usual > 0 ? current / usual : 1);
    const verdictOf = (ratios: number[]): TrafficVerdict =>
      ratios.every((r) => r <= low) ? "drop" : ratios.every((r) => r >= RESTORE_RATIO) ? "ok" : null;

    for (const s of judged) {
      const own = verdictOf([0, 1].map((k) => ratio(s.now![k], s.usual![k])));
      // Нода «пропала» сама по себе, только если остальные в норме: иначе это просадка сети
      const othersFine = ([0, 1] as const).every((k) => {
        const othersUsual = total(k, "usual") - s.usual![k];
        return othersUsual <= 0 || (total(k, "now") - s.now![k]) / othersUsual >= RESTORE_RATIO;
      });
      s.verdict = own === "drop" && !othersFine ? null : own;
    }

    const networkRatios = ([0, 1] as const).map((k) => ratio(total(k, "now"), total(k, "usual")));
    const networkVerdict = verdictOf(networkRatios);
    return {
      slotEnd,
      minUsers,
      dropPct,
      nodes: statuses,
      network: {
        now: [total(0, "now"), total(1, "now")],
        usual: [total(0, "usual"), total(1, "usual")],
        // одна нода — это событие ноды; сеть судим от двух оцениваемых
        verdict: judged.length === 0 || (networkVerdict === "drop" && judged.length < 2) ? null : networkVerdict,
        evaluated: judged.length,
      },
    };
  }

  /**
   * Прогон джобы: вердикты → переходы в ленту мониторинга. Событие — только на смене состояния;
   * под блокировкой, чтобы параллельный прогон не записал тот же переход второй раз.
   */
  async run(now = new Date()) {
    const evaluation = await this.evaluate(now);
    const events = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`monitor-traffic:${this.org}`}, 0))`);
      const lastByNode = await tx
        .selectDistinctOn([schema.monitorEvent.nodeId], { nodeId: schema.monitorEvent.nodeId, kind: schema.monitorEvent.kind })
        .from(schema.monitorEvent)
        .where(and(eq(schema.monitorEvent.orgId, this.org), inArray(schema.monitorEvent.kind, NODE_KINDS)))
        .orderBy(schema.monitorEvent.nodeId, desc(schema.monitorEvent.createdAt));
      const [lastNetwork] = await tx
        .select({ kind: schema.monitorEvent.kind })
        .from(schema.monitorEvent)
        .where(and(eq(schema.monitorEvent.orgId, this.org), inArray(schema.monitorEvent.kind, NETWORK_KINDS)))
        .orderBy(desc(schema.monitorEvent.createdAt))
        .limit(1);
      const nodeDown = new Set(lastByNode.filter((e) => e.kind === "traffic_drop").map((e) => e.nodeId));

      const inserts: Array<typeof schema.monitorEvent.$inferInsert> = [];
      for (const n of evaluation.nodes) {
        const down = nodeDown.has(n.nodeId);
        if (n.verdict === "drop" && !down) inserts.push(this.nodeEvent(n, "traffic_drop"));
        if (n.verdict === "ok" && down) inserts.push(this.nodeEvent(n, "traffic_restore"));
      }
      const networkDown = lastNetwork?.kind === "network_traffic_drop";
      const net = evaluation.network;
      if (net.verdict === "drop" && !networkDown) {
        inserts.push({
          orgId: this.org,
          kind: "network_traffic_drop",
          message: `по всей сети активных клиентов ${net.now[1]} при обычных ${Math.round(net.usual[1])} (−${dropOf(net.now[1], net.usual[1])}%) — проверьте выдачу подписки и доступность сети`,
        });
      }
      if (net.verdict === "ok" && networkDown) {
        inserts.push({
          orgId: this.org,
          kind: "network_traffic_restore",
          message: `трафик по сети восстановился: активных ${net.now[1]}, обычно ${Math.round(net.usual[1])}`,
        });
      }
      if (inserts.length > 0) await tx.insert(schema.monitorEvent).values(inserts);
      return inserts;
    });

    for (const e of events) {
      if (e.kind.endsWith("_drop")) this.log.warn(`трафик: ${e.kind} ${e.nodeId ?? "сеть"} — ${e.message}`);
      else this.log.log(`трафик: ${e.kind} ${e.nodeId ?? "сеть"} — ${e.message}`);
    }
    const skipped: Record<string, number> = {};
    for (const n of evaluation.nodes) if (n.skipped) skipped[n.skipped] = (skipped[n.skipped] ?? 0) + 1;
    return { slotEnd: evaluation.slotEnd, evaluated: evaluation.network.evaluated, skipped, events: events.length };
  }

  private nodeEvent(n: NodeTraffic, kind: "traffic_drop" | "traffic_restore"): typeof schema.monitorEvent.$inferInsert {
    const [current, usual] = [n.now![1], n.usual![1]];
    return {
      orgId: this.org,
      nodeId: n.nodeId,
      kind,
      message:
        kind === "traffic_drop"
          ? `активных клиентов ${current} при обычных ${Math.round(usual)} в это время (−${dropOf(current, usual)}%), нода на связи — блокировка для клиентов или уход с ноды`
          : `клиенты вернулись: активных ${current}, обычно ${Math.round(usual)}`,
    };
  }

  /**
   * Активные клиенты по (нода, слот). Строка есть, если агент прислал за слот хоть что-то
   * (хотя бы опрос `api`): её отсутствие — «нет статистики», а не «ноль клиентов».
   */
  private async activeBySlot(slotStarts: number[]): Promise<Map<string, number>> {
    const service = await this.db
      .select({ key: schema.subscription.shortUuid })
      .from(schema.monitorProbe)
      .innerJoin(schema.subscription, eq(schema.subscription.id, schema.monitorProbe.subscriptionId))
      .where(eq(schema.monitorProbe.orgId, this.org));
    const notService =
      service.length > 0 ? sql`and subject_key not in (${sql.join(service.map((s) => sql`${s.key}`), sql`, `)})` : sql``;
    const slots = sql.join(
      slotStarts.map((s) => sql`(${new Date(s).toISOString()}::timestamptz)`),
      sql`, `,
    );

    const rows = (await this.db.execute(sql`
      with slots(slot_start) as (values ${slots}),
      per_subject as (
        select ts.node_id, sl.slot_start, ts.subject_type, ts.subject_key,
               sum(ts.up_delta + ts.down_delta) as bytes
        from slots sl
        join traffic_sample ts
          on ts.org_id = ${this.org}
         and ts.window_start >= sl.slot_start
         and ts.window_start < sl.slot_start + interval '5 minutes'
        group by 1, 2, 3, 4
      )
      select node_id, slot_start,
             count(*) filter (where subject_type = 'user' and bytes >= ${ACTIVE_BYTES} ${notService})::int as active
      from per_subject
      group by 1, 2
    `)) as unknown as Array<{ node_id: string; slot_start: Date | string; active: number }>;

    return new Map(rows.map((r) => [`${r.node_id}|${new Date(r.slot_start).getTime()}`, Number(r.active)]));
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function dropOf(current: number, usual: number): number {
  return usual > 0 ? Math.round((1 - current / usual) * 100) : 0;
}
