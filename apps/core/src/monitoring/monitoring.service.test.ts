/**
 * Мониторинг: синтетическая проба и её учёт.
 *
 * Исполнитель подменён — проверяется не curl, а то, что вокруг: проба достаёт каждый канал
 * (в том числе своего squad'а), событие в ленте пишется только на смене состояния, а сбой
 * самой пробы не превращается в «упали все ноды».
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import type { ProbeTarget } from "@corelink/xray-config";
import { TEST_ORG_ID, cleanupOrg, closeDb, openDb } from "../testing/fixtures.test.js";
import { InfraService } from "../nodes/infra.service.js";
import { locationChannelTag } from "../nodes/location-delivery.js";
import { NodeStateService } from "../nodes/node-state.service.js";
import { SubscriptionRepository } from "../subscription/subscription.repository.js";
import { MonitoringService } from "./monitoring.service.js";
import { ProbeInfraError, type ProbeExecutor } from "./probe-executor.js";

let db: Database;
let infra: InfraService;
let service: MonitoringService;
/** Что вернёт исполнитель: тег канала → прошёл ли. Не указан — прошёл. */
let verdicts: Map<string, boolean>;
let infraFailure: string | null;
let probed: ProbeTarget[];

const fakeExecutor: ProbeExecutor = async (_config, targets) => {
  if (infraFailure) throw new ProbeInfraError(infraFailure);
  probed = targets;
  return targets.map((t) => {
    const ok = verdicts.get(t.tag) ?? true;
    return { tag: t.tag, ok, latencyMs: ok ? 42 : null, error: ok ? null : "curl: (28) Operation timed out" };
  });
};

before(() => {
  db = openDb();
  const state = new NodeStateService(db);
  infra = new InfraService(db, state);
  service = new MonitoringService(db, new SubscriptionRepository(db), state, fakeExecutor);
});

beforeEach(async () => {
  verdicts = new Map();
  infraFailure = null;
  probed = [];
  await cleanupOrg(db);
});

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

let octet = 60;

/** Локация мастером + энроллмент её ноды: Reality-ключ приезжает с ноды, до него канала нет. */
async function location(extra: Record<string, unknown> = {}, enrolled = true) {
  octet += 1;
  const res = await infra.provisionLocation({
    name: `mon-${octet}`,
    primaryIp: `203.0.113.${octet}`,
    sni: "ads.x5.ru",
    country: "DE",
    ...extra,
  });
  if (enrolled) await db.update(schema.host).set({ pbk: `PBK_MON_${octet}` }).where(eq(schema.host.nodeId, res.node.id));
  return { nodeId: res.node.id, tag: locationChannelTag(res.node.id) };
}

async function events() {
  return db
    .select({ kind: schema.monitorEvent.kind, channelTag: schema.monitorEvent.channelTag })
    .from(schema.monitorEvent)
    .where(eq(schema.monitorEvent.orgId, TEST_ORG_ID))
    .orderBy(schema.monitorEvent.createdAt);
}

describe("проба из дата-центра", () => {
  it("заводит служебную подписку один раз и открывает ей все squad'ы", async () => {
    await location();
    const premium = await infra.createSquad({ name: "Премиум" });

    const first = await service.ensureDcProbe();
    const second = await service.ensureDcProbe();

    assert.equal(first.id, second.id);
    const probes = await db.select().from(schema.monitorProbe).where(eq(schema.monitorProbe.orgId, TEST_ORG_ID));
    assert.equal(probes.length, 1);
    const memberships = await db
      .select({ squadId: schema.subscriptionSquad.squadId })
      .from(schema.subscriptionSquad)
      .where(eq(schema.subscriptionSquad.subscriptionId, first.subscriptionId));
    assert.ok(
      memberships.some((m) => m.squadId === premium.id),
      "канал своего squad'а числился бы упавшим, если проба туда не пущена",
    );
  });

  it("проверяет каждый канал — и общего squad'а, и своего", async () => {
    const shared = await location();
    const premium = await infra.createSquad({ name: "Премиум" });
    const vipOnly = await location({ inGeneral: false, squadIds: [premium.id] });

    await service.runDcProbe();

    const tags = probed.map((t) => t.tag).sort();
    assert.deepEqual(tags, [shared.tag, vipOnly.tag].sort());
  });

  it("локация до энроллмента не ослепляет пробу: её канал пропущен, остальные проверены", async () => {
    const ready = await location();
    await location({}, false);

    await service.runDcProbe();

    assert.deepEqual(
      probed.map((t) => t.tag),
      [ready.tag],
      "канал без ключа валит Xray пробы целиком — все каналы остались бы непроверенными",
    );
  });

  it("событие в ленте — только на смене состояния канала", async () => {
    const a = await location();
    const b = await location();

    verdicts = new Map([[b.tag, false]]);
    await service.runDcProbe();
    assert.deepEqual(await events(), [{ kind: "probe_down", channelTag: b.tag }], "новый канал сразу упал — это событие");

    verdicts = new Map([[a.tag, false]]);
    await service.runDcProbe();
    const afterSwap = await events();
    assert.equal(afterSwap.length, 3);
    assert.ok(afterSwap.some((e) => e.kind === "probe_down" && e.channelTag === a.tag));
    assert.ok(afterSwap.some((e) => e.kind === "probe_up" && e.channelTag === b.tag));

    await service.runDcProbe();
    assert.equal((await events()).length, 3, "повторный провал ленту не засоряет");
  });

  it("плановый и ручной прогоны разом не двоят событие в ленте", async () => {
    const a = await location();
    verdicts = new Map([[a.tag, false]]);

    await Promise.all([service.runDcProbe(), service.runDcProbe(), service.runDcProbe()]);

    const results = await db.select().from(schema.probeResult).where(eq(schema.probeResult.orgId, TEST_ORG_ID));
    assert.equal(results.length, 3, "каждый прогон записал свой результат");
    assert.deepEqual(await events(), [{ kind: "probe_down", channelTag: a.tag }]);
  });

  it("сбой самой пробы не рисует падение нод: результатов нет, ошибка — у точки наблюдения", async () => {
    await location();
    infraFailure = "xray пробы не поднялся: spawn xray ENOENT";

    await assert.rejects(() => service.runDcProbe(), (e) => e instanceof ProbeInfraError);

    const results = await db.select().from(schema.probeResult).where(eq(schema.probeResult.orgId, TEST_ORG_ID));
    assert.equal(results.length, 0);
    const [probe] = await db
      .select()
      .from(schema.monitorProbe)
      .where(and(eq(schema.monitorProbe.orgId, TEST_ORG_ID), eq(schema.monitorProbe.kind, "dc")));
    assert.match(probe.lastError ?? "", /ENOENT/);
    assert.ok(probe.lastRunAt, "время прогона видно — молчание мониторинга не выглядит как «всё хорошо»");
  });

  it("сводка: последнее состояние канала и доступность за сутки", async () => {
    const a = await location();

    await service.runDcProbe();
    verdicts = new Map([[a.tag, false]]);
    await service.runDcProbe();

    const view = await service.overview();
    const channel = view.channels.find((c) => c.channelTag === a.tag)!;
    assert.equal(channel.ok, false);
    assert.equal(channel.nodeId, a.nodeId);
    assert.equal(channel.checks24h, 2);
    assert.equal(channel.passed24h, 1);
    assert.equal(view.probes.length, 1);
    assert.equal(view.probes[0].lastError, null);
    assert.ok(view.events.some((e) => e.kind === "probe_down" && e.channelTag === a.tag));
  });
});
