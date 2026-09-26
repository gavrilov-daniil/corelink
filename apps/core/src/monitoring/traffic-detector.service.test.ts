/**
 * Детектор по трафику клиентов: неделя синтетической статистики и фиксированное «сейчас».
 *
 * Главное — не врать. Тревога только при живой ноде, достаточной базе клиентов и двух
 * плохих слотах подряд; служебный трафик и застрявшие рукопожатия клиентами не считаются;
 * просадка всей сети — одно событие, а не по событию на каждую ноду.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { TEST_ORG_ID, cleanupOrg, closeDb, createSubscriber, openDb } from "../testing/fixtures.test.js";
import { InfraService } from "../nodes/infra.service.js";
import { NodeStateService } from "../nodes/node-state.service.js";
import { TrafficDetectorService } from "./traffic-detector.service.js";

let db: Database;
let infra: InfraService;
let detector: TrafficDetectorService;

// «Сейчас» 12:07:30 → закрытые слоты 11:55 и 12:00 (слот закрыт через 2 минуты после конца)
const NOW = new Date("2026-09-20T12:07:30.000Z");
const SLOTS = [Date.parse("2026-09-20T11:55:00.000Z"), Date.parse("2026-09-20T12:00:00.000Z")] as const;
const DAY_MS = 86_400_000;

before(() => {
  db = openDb();
  infra = new InfraService(db, new NodeStateService(db));
  detector = new TrafficDetectorService(db);
});

beforeEach(async () => {
  await cleanupOrg(db);
});

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

let octet = 150;

/** Нода мастером; online — heartbeat в «сейчас», иначе 10 минут назад. */
async function node(online = true) {
  octet += 1;
  const res = await infra.provisionLocation({
    name: `td-${octet}`,
    primaryIp: `203.0.113.${octet}`,
    sni: "ads.x5.ru",
    country: "DE",
  });
  const heartbeatAt = online ? NOW : new Date(NOW.getTime() - 10 * 60_000);
  await db
    .insert(schema.nodeReportedState)
    .values({ nodeId: res.node.id, heartbeatAt })
    .onConflictDoUpdate({ target: schema.nodeReportedState.nodeId, set: { heartbeatAt } });
  return res.node.id;
}

/**
 * Слот ноды: опрос `api` (агент жив и шлёт статистику) и `users` клиентов по `bytes` байт.
 * Ключ клиента — `${prefix}-${i}`: один и тот же человек из слота в слот.
 */
async function slot(nodeId: string, start: number, users: number, opts: { bytes?: number; prefix?: string } = {}) {
  const windowStart = new Date(start + 30_000);
  const windowEnd = new Date(start + 60_000);
  const base = { orgId: TEST_ORG_ID, nodeId, windowStart, windowEnd };
  const rows = [{ ...base, subjectType: "inbound", subjectKey: "api", upDelta: 200, downDelta: 1_800 }];
  for (let i = 0; i < users; i++) {
    rows.push({
      ...base,
      subjectType: "user",
      subjectKey: `${opts.prefix ?? "u"}-${i}`,
      upDelta: 10_000,
      downDelta: opts.bytes ?? 200_000,
    });
  }
  await db.insert(schema.trafficSample).values(rows);
}

/** История: те же два слота на каждом из `days` предыдущих дней. */
async function history(nodeId: string, users: number, days = 7) {
  for (let d = 1; d <= days; d++) for (const s of SLOTS) await slot(nodeId, s - d * DAY_MS, users);
}

async function current(nodeId: string, users: [number, number]) {
  await slot(nodeId, SLOTS[0], users[0]);
  await slot(nodeId, SLOTS[1], users[1]);
}

async function events() {
  return db
    .select({ kind: schema.monitorEvent.kind, nodeId: schema.monitorEvent.nodeId, message: schema.monitorEvent.message })
    .from(schema.monitorEvent)
    .where(eq(schema.monitorEvent.orgId, TEST_ORG_ID))
    .orderBy(schema.monitorEvent.createdAt);
}

async function statusOf(nodeId: string) {
  const view = await detector.evaluate(NOW);
  return view.nodes.find((n) => n.nodeId === nodeId)!;
}

describe("детектор по трафику клиентов", () => {
  it("клиенты пропали с живой ноды при норме у остальных — событие с цифрами", async () => {
    const [a, b] = [await node(), await node()];
    await history(a, 20);
    await history(b, 20);
    await current(a, [2, 1]);
    await current(b, [19, 21]);

    await detector.run(NOW);

    const log = await events();
    assert.equal(log.length, 1);
    assert.equal(log[0]!.kind, "traffic_drop");
    assert.equal(log[0]!.nodeId, a);
    assert.match(log[0]!.message ?? "", /активных клиентов 1 при обычных 20.*−95%/);
  });

  it("один плохой слот — не повод: нужно два подряд", async () => {
    const a = await node();
    await history(a, 20);
    await current(a, [19, 2]);

    await detector.run(NOW);

    assert.deepEqual(await events(), []);
    assert.equal((await statusOf(a)).verdict, null, "переходное состояние: ни «пропали», ни «в норме»");
  });

  it("клиенты вернулись — «вернулись»; повторный прогон ничего не двоит", async () => {
    const a = await node();
    await history(a, 20);
    await current(a, [1, 0]);
    await detector.run(NOW);
    await detector.run(NOW);
    assert.deepEqual((await events()).map((e) => e.kind), ["traffic_drop"], "состояние не менялось — событие одно");

    await db
      .delete(schema.trafficSample)
      .where(
        and(
          eq(schema.trafficSample.orgId, TEST_ORG_ID),
          inArray(schema.trafficSample.windowStart, [new Date(SLOTS[0] + 30_000), new Date(SLOTS[1] + 30_000)]),
        ),
      );
    await current(a, [17, 18]);
    await detector.run(NOW);

    const log = await events();
    assert.deepEqual(log.map((e) => e.kind), ["traffic_drop", "traffic_restore"]);
    assert.match(log[1]!.message ?? "", /клиенты вернулись: активных 18, обычно 20/);
  });

  it("мало клиентов — детектор молчит: на единицах «пропали» неотличимо от «легли спать»", async () => {
    const a = await node();
    await history(a, 5);
    await current(a, [0, 0]);

    await detector.run(NOW);

    assert.deepEqual(await events(), []);
    const status = await statusOf(a);
    assert.equal(status.skipped, "few_clients");
    assert.deepEqual(status.usual, [5, 5]);
  });

  it("служебная проба и застрявшие рукопожатия активными клиентами не считаются", async () => {
    const a = await node();
    await history(a, 20);
    const person = await createSubscriber(db);
    const [probeSub] = await db
      .insert(schema.subscription)
      .values({
        orgId: TEST_ORG_ID,
        subscriberId: person.id,
        shortUuid: randomBytes(12).toString("hex"),
        vlessUuid: randomUUID(),
        status: "active",
      })
      .returning();
    await db.insert(schema.monitorProbe).values({ orgId: TEST_ORG_ID, kind: "dc", name: "проба", subscriptionId: probeSub!.id });
    for (const s of SLOTS) {
      await slot(a, s, 30, { bytes: 3_000, prefix: "stuck" }); // рукопожатия без данных
      await db.insert(schema.trafficSample).values({
        orgId: TEST_ORG_ID,
        nodeId: a,
        subjectType: "user",
        subjectKey: probeSub!.shortUuid,
        upDelta: 50_000,
        downDelta: 5_000_000,
        windowStart: new Date(s + 90_000),
        windowEnd: new Date(s + 120_000),
      });
    }

    await detector.run(NOW);

    assert.deepEqual((await statusOf(a)).now, [0, 0]);
    assert.deepEqual((await events()).map((e) => e.kind), ["traffic_drop"]);
  });

  it("просела вся сеть — одно событие по сети, а не по каждой ноде", async () => {
    const [a, b] = [await node(), await node()];
    await history(a, 20);
    await history(b, 30);
    await current(a, [1, 2]);
    await current(b, [3, 2]);

    await detector.run(NOW);

    const log = await events();
    assert.deepEqual(log.map((e) => [e.kind, e.nodeId]), [["network_traffic_drop", null]]);
    assert.match(log[0]!.message ?? "", /по всей сети активных клиентов 4 при обычных 50/);
  });

  it("нода не на связи или без статистики — детектор не судит: это забота пробы и heartbeat", async () => {
    const offline = await node(false);
    const silent = await node();
    await history(offline, 20);
    await history(silent, 20);
    await current(offline, [0, 0]);

    await detector.run(NOW);

    assert.deepEqual(await events(), []);
    assert.equal((await statusOf(offline)).skipped, "offline");
    assert.equal((await statusOf(silent)).skipped, "no_stats", "нет окон от агента — это не «ноль клиентов»");
  });

  it("истории меньше трёх дней — «обычное» ещё не известно", async () => {
    const a = await node();
    await history(a, 20, 2);
    await current(a, [0, 0]);

    await detector.run(NOW);

    assert.deepEqual(await events(), []);
    assert.equal((await statusOf(a)).skipped, "no_history");
  });

  it("параллельные прогоны не двоят событие", async () => {
    const a = await node();
    await history(a, 20);
    await current(a, [0, 1]);

    await Promise.all([detector.run(NOW), detector.run(NOW), detector.run(NOW)]);

    assert.deepEqual((await events()).map((e) => e.kind), ["traffic_drop"]);
  });
});
