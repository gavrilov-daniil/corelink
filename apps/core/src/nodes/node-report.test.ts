/**
 * Отчёт агента о здоровье Xray.
 *
 * Инвариант: совпавший хеш конфига — ещё не сходимость. Если агент сообщил, что Xray
 * не работает (чужой процесс держит порт, упал позже), нода не сошлась — ни в админке,
 * ни для каскадов, которые иначе раздавались бы клиентам через мёртвое плечо.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { TEST_ORG_ID, cleanupOrg, closeDb, openDb } from "../testing/fixtures.test.js";
import { AdminController } from "../admin/admin.controller.js";
import { CascadeService } from "./cascade.service.js";
import { InfraService } from "./infra.service.js";
import { NodeStateService } from "./node-state.service.js";

let db: Database;
let state: NodeStateService;
let infra: InfraService;
let cascades: CascadeService;
let admin: AdminController;

before(() => {
  db = openDb();
  state = new NodeStateService(db);
  infra = new InfraService(db, state);
  cascades = new CascadeService(db, state);
  admin = new AdminController(db);
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

const BIND_ERROR =
  "xray не работает (failed): Failed to start: app/proxyman/inbound: failed to listen TCP on 443 > bind: address already in use";

let octet = 20;

async function location(roles: string[] = ["exit"]) {
  octet += 1;
  const res = await infra.provisionLocation({
    name: `n-${randomUUID().slice(0, 6)}`,
    primaryIp: `203.0.113.${octet}`,
    sni: "ads.x5.ru",
    roles,
    inGeneral: false,
  });
  return { nodeId: res.node.id, inboundTag: res.inbound.label };
}

async function desiredHash(nodeId: string): Promise<string> {
  const [row] = await db.select().from(schema.nodeDesiredState).where(eq(schema.nodeDesiredState.nodeId, nodeId));
  return row.configHash;
}

async function reportedError(nodeId: string): Promise<string | null> {
  const [row] = await db.select().from(schema.nodeReportedState).where(eq(schema.nodeReportedState.nodeId, nodeId));
  return row.xrayError;
}

async function adminRow(nodeId: string) {
  return (await admin.nodes()).find((n) => n.id === nodeId)!;
}

describe("отчёт агента: Xray не работает", () => {
  it("ошибка Xray сохраняется, а следующий здоровый отчёт её снимает", async () => {
    const { nodeId } = await location();
    const hash = await desiredHash(nodeId);

    await state.report(nodeId, { appliedConfigHash: hash, xrayError: BIND_ERROR });
    assert.equal(await reportedError(nodeId), BIND_ERROR);

    await state.report(nodeId, { appliedConfigHash: hash });
    assert.equal(await reportedError(nodeId), null, "починенный Xray не должен висеть в админке с прошлой ошибкой");
  });

  it("совпавший хеш при лежащем Xray — не сходимость: админка показывает ошибку", async () => {
    const { nodeId } = await location();
    const hash = await desiredHash(nodeId);

    await state.report(nodeId, { appliedConfigHash: hash, xrayError: BIND_ERROR });
    const broken = await adminRow(nodeId);
    assert.equal(broken.converged, false, "мёртвая нода числилась сошедшейся — баг de1-exit 26.09.2026");
    assert.equal(broken.xrayError, BIND_ERROR);

    await state.report(nodeId, { appliedConfigHash: hash });
    const healed = await adminRow(nodeId);
    assert.equal(healed.converged, true);
    assert.equal(healed.xrayError, null);
  });

  it("пустая строка ошибки — это «работает», а не пустая ошибка", async () => {
    const { nodeId } = await location();
    await state.report(nodeId, { appliedConfigHash: await desiredHash(nodeId), xrayError: "   " });
    assert.equal(await reportedError(nodeId), null);
  });

  it("каскад через плечо с лежащим Xray выходит из active — клиентам его не раздают", async () => {
    const exit = await location(["exit"]);
    const relay = await location(["relay"]);
    const [link] = await db
      .insert(schema.cascadeLink)
      .values({
        orgId: TEST_ORG_ID,
        kind: "server_forward",
        cc: "DE",
        relayNodeId: relay.nodeId,
        exitNodeId: exit.nodeId,
        exitInboundTag: exit.inboundTag,
        linkUserUuid: randomUUID(),
      })
      .returning();
    // каскад меняет конфиг обеих нод (link-user на exit, форвард на relay)
    await state.rebuild(exit.nodeId);
    await state.rebuild(relay.nodeId);
    const exitHash = await desiredHash(exit.nodeId);
    const relayHash = await desiredHash(relay.nodeId);

    await state.report(exit.nodeId, { appliedConfigHash: exitHash });
    await state.report(relay.nodeId, { appliedConfigHash: relayHash });
    assert.equal((await cascades.refreshStatus(link.id))?.status, "active");

    await state.report(exit.nodeId, { appliedConfigHash: exitHash, xrayError: BIND_ERROR });
    assert.equal((await cascades.refreshStatus(link.id))?.status, "planned");
  });
});
