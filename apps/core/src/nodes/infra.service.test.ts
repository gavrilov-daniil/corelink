/**
 * Заведение сети из админки.
 *
 * Два инварианта, ради которых этот файл существует:
 *   1) мусор отвергается на границе, а не всплывает при сборке конфига ноды;
 *   2) любая правка, влияющая на конфиг, поднимает версию desired-state — иначе
 *      изменение в админке молча не доезжает до ноды.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { TEST_ORG_ID, cleanupOrg, closeDb, createSubscriber, createSubscription, openDb } from "../testing/fixtures.test.js";
import { NodeStateService } from "./node-state.service.js";
import { InfraService } from "./infra.service.js";

let db: Database;
let infra: InfraService;
let state: NodeStateService;

before(() => {
  db = openDb();
  state = new NodeStateService(db);
  infra = new InfraService(db, state);
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

const REALITY = { sni: "ads.x5.ru", fingerprint: "firefox", flow: "xtls-rprx-vision" };

async function server(patch: Record<string, unknown> = {}) {
  return infra.createServer({
    hostname: `srv-${Math.random().toString(36).slice(2, 10)}.example.com`,
    primaryIp: "203.0.113.10",
    country: "DE",
    ...patch,
  });
}

async function profile(name = `cfg-${Math.random().toString(36).slice(2, 10)}`) {
  return infra.createConfigProfile({ name });
}

async function node(patch: Record<string, unknown> = {}) {
  const srv = await server();
  const cfg = await profile();
  return infra.createNode({ serverId: srv.id, configProfileId: cfg.id, name: `node-${srv.hostname}`, roles: ["exit"], ...patch });
}

/** Статус ответа Nest-исключения: тип важнее текста, текст в разных ветках разный. */
function status(err: unknown): number {
  return (err as { status?: number }).status ?? 0;
}

async function inboundTags(nodeId: string): Promise<string[]> {
  const desired = await state.getDesiredState(nodeId);
  const inbounds = (desired.config as { inbounds?: Array<{ tag?: string }> }).inbounds ?? [];
  return inbounds.map((i) => i.tag ?? "").filter(Boolean);
}

async function desiredVersion(nodeId: string): Promise<number> {
  const [row] = await db.select().from(schema.node).where(eq(schema.node.id, nodeId)).limit(1);
  return row.desiredConfigVersion;
}

describe("валидация входа", () => {
  it("порт вне 1..65535 не принимается", async () => {
    const cfg = await profile();
    await assert.rejects(
      () => infra.createInbound({ configProfileId: cfg.id, tag: "VLESS_TEST", port: 70000, ...REALITY }),
      (e) => status(e) === 400 && /port/.test((e as Error).message),
    );
    await assert.rejects(
      () => infra.createInbound({ configProfileId: cfg.id, tag: "VLESS_TEST", port: 0, ...REALITY }),
      (e) => status(e) === 400,
    );
  });

  it("роль вне exit|relay|front не принимается", async () => {
    const srv = await server();
    const cfg = await profile();
    await assert.rejects(
      () => infra.createNode({ serverId: srv.id, configProfileId: cfg.id, name: "n", roles: ["gateway"] }),
      (e) => status(e) === 400 && /roles/.test((e as Error).message),
    );
  });

  it("тег с пробелом Xray не примет — не примем и мы", async () => {
    const cfg = await profile();
    await assert.rejects(
      () => infra.createInbound({ configProfileId: cfg.id, tag: "VLESS REALITY DE", port: 443, ...REALITY }),
      (e) => status(e) === 400 && /tag/.test((e as Error).message),
    );
  });

  it("security=reality без sni отвергается", async () => {
    const cfg = await profile();
    await assert.rejects(
      () => infra.createInbound({ configProfileId: cfg.id, tag: "VLESS_NO_SNI", port: 443, security: "reality" }),
      (e) => status(e) === 400 && /sni/.test((e as Error).message),
    );
  });

  it("vision на grpc отвергается: Xray такую пару не поднимет", async () => {
    const cfg = await profile();
    await assert.rejects(
      () =>
        infra.createInbound({
          configProfileId: cfg.id,
          tag: "VLESS_GRPC",
          port: 443,
          network: "grpc",
          flow: "xtls-rprx-vision",
          sni: "ads.x5.ru",
        }),
      (e) => status(e) === 400 && /flow/.test((e as Error).message),
    );
  });

  it("shortId не-hex отвергается", async () => {
    const cfg = await profile();
    await assert.rejects(
      () => infra.createInbound({ configProfileId: cfg.id, tag: "VLESS_SID", port: 443, shortIds: ["zzz"], ...REALITY }),
      (e) => status(e) === 400 && /shortIds/.test((e as Error).message),
    );
  });

  it("primaryIp не-IP отвергается", async () => {
    await assert.rejects(
      () => infra.createServer({ hostname: "srv.example.com", primaryIp: "не-айпи" }),
      (e) => status(e) === 400 && /primaryIp/.test((e as Error).message),
    );
  });

  it("неизвестный fingerprint отвергается", async () => {
    const cfg = await profile();
    await assert.rejects(
      () => infra.createInbound({ configProfileId: cfg.id, tag: "VLESS_FP", port: 443, ...REALITY, fingerprint: "netscape" }),
      (e) => status(e) === 400 && /fingerprint/.test((e as Error).message),
    );
  });

  it("PATCH без единого известного поля — 400, а не молчаливый no-op", async () => {
    const n = await node();
    await assert.rejects(
      () => infra.updateNode(n.id, { somethingElse: 1 }),
      (e) => status(e) === 400,
    );
  });
});

describe("инвариант «1 config-профиль = 1 нода»", () => {
  it("вторая нода на тот же профиль отвергается с объяснением", async () => {
    const srv = await server();
    const cfg = await profile();
    await infra.createNode({ serverId: srv.id, configProfileId: cfg.id, name: "n1", roles: ["exit"] });

    await assert.rejects(
      () => infra.createNode({ serverId: srv.id, configProfileId: cfg.id, name: "n2", roles: ["exit"] }),
      (e) => status(e) === 409 && /занят другой нодой/.test((e as Error).message),
    );
  });

  it("перевод существующей ноды на занятый профиль тоже отвергается", async () => {
    const srv = await server();
    const busy = await profile();
    await infra.createNode({ serverId: srv.id, configProfileId: busy.id, name: "n1", roles: ["exit"] });
    const free = await profile();
    const second = await infra.createNode({ serverId: srv.id, configProfileId: free.id, name: "n2", roles: ["exit"] });

    await assert.rejects(
      () => infra.updateNode(second.id, { configProfileId: busy.id }),
      (e) => status(e) === 409,
    );
  });
});

describe("пересборка desired-state", () => {
  it("новый inbound доезжает до конфига ноды и поднимает версию", async () => {
    const n = await node();
    const before = await desiredVersion(n.id);

    const created = await infra.createInbound({
      configProfileId: n.configProfileId,
      tag: "VLESS_REALITY_DE",
      port: 443,
      ...REALITY,
    });

    assert.equal(created.rebuilt.length, 1);
    assert.equal(created.rebuilt[0].changed, true);
    assert.ok(await desiredVersion(n.id) > before, "версия desired-state должна вырасти");
    assert.deepEqual(await inboundTags(n.id), ["VLESS_REALITY_DE", "api"].sort());
  });

  it("правка порта inbound'а поднимает версию заново", async () => {
    const n = await node();
    const created = await infra.createInbound({
      configProfileId: n.configProfileId,
      tag: "VLESS_REALITY_DE",
      port: 443,
      ...REALITY,
    });
    const before = await desiredVersion(n.id);

    const updated = await infra.updateInbound(created.id, { port: 8443 });
    assert.equal(updated.rebuilt[0]?.changed, true);
    assert.ok(await desiredVersion(n.id) > before);

    const desired = await state.getDesiredState(n.id);
    const inbounds = (desired.config as { inbounds: Array<{ tag: string; port: number }> }).inbounds;
    assert.equal(inbounds.find((i) => i.tag === "VLESS_REALITY_DE")?.port, 8443);
  });

  it("правка, не меняющая конфиг ноды, версию не двигает", async () => {
    const n = await node();
    await infra.createInbound({ configProfileId: n.configProfileId, tag: "VLESS_REALITY_DE", port: 443, ...REALITY });
    const before = await desiredVersion(n.id);

    const updated = await infra.updateNode(n.id, { sortOrder: 7 });
    assert.equal(updated.rebuilt[0]?.changed, false);
    assert.equal(await desiredVersion(n.id), before);
  });

  it("состав squad'а меняет список пользователей ноды", async () => {
    const n = await node();
    const inbound = await infra.createInbound({
      configProfileId: n.configProfileId,
      tag: "VLESS_REALITY_DE",
      port: 443,
      ...REALITY,
    });

    const subscriber = await createSubscriber(db);
    const subscription = await createSubscription(db, subscriber.id);
    const squad = await infra.createSquad({ name: "тест-squad" });
    await db.insert(schema.subscriptionSquad).values({ subscriptionId: subscription.id, squadId: squad.id });

    const before = await desiredVersion(n.id);
    const updated = await infra.updateSquad(squad.id, { inboundIds: [inbound.id] });

    assert.equal(updated.rebuilt[0]?.changed, true);
    assert.ok(await desiredVersion(n.id) > before);

    const desired = await state.getDesiredState(n.id);
    assert.ok(
      desired.users.some((u) => u.uuid === subscription.vlessUuid),
      "подписчик squad'а должен появиться в desired-state",
    );

    // и обратно: убрали inbound из squad'а — пользователь ушёл с ноды
    await infra.updateSquad(squad.id, { inboundIds: [] });
    const after = await state.getDesiredState(n.id);
    assert.equal(after.users.some((u) => u.uuid === subscription.vlessUuid), false);
  });

  it("создание ноды сразу даёт desired-state: в списке она не висит без версии", async () => {
    const n = await node();
    assert.equal(n.rebuilt.length, 1);
    const [row] = await db.select().from(schema.nodeDesiredState).where(eq(schema.nodeDesiredState.nodeId, n.id));
    assert.ok(row, "desired-state должен появиться при создании ноды");
  });
});

describe("удаление под ссылками", () => {
  it("inbound под squad'ом не удаляется", async () => {
    const n = await node();
    const inbound = await infra.createInbound({
      configProfileId: n.configProfileId,
      tag: "VLESS_REALITY_DE",
      port: 443,
      ...REALITY,
    });
    const squad = await infra.createSquad({ name: "держит-inbound", inboundIds: [inbound.id] });

    await assert.rejects(
      () => infra.deleteInbound(inbound.id),
      (e) => status(e) === 409 && /squad/.test((e as Error).message),
    );

    await infra.updateSquad(squad.id, { inboundIds: [] });
    assert.deepEqual((await infra.deleteInbound(inbound.id)).ok, true);
  });

  it("inbound под каскадом не удаляется", async () => {
    const n = await node();
    const inbound = await infra.createInbound({
      configProfileId: n.configProfileId,
      tag: "VLESS_REALITY_DE",
      port: 443,
      ...REALITY,
    });
    await db.insert(schema.cascadeLink).values({
      orgId: TEST_ORG_ID,
      kind: "client_chain",
      cc: "DE",
      exitNodeId: n.id,
      exitInboundTag: inbound.tag,
      linkUserUuid: "11111111-1111-1111-1111-111111111111",
      status: "active",
    });

    await assert.rejects(
      () => infra.deleteInbound(inbound.id),
      (e) => status(e) === 409 && /каскад/.test((e as Error).message),
    );
    // переименование тега уводит каскад в никуда — тоже отвергаем
    await assert.rejects(
      () => infra.updateInbound(inbound.id, { tag: "VLESS_REALITY_DE2" }),
      (e) => status(e) === 409,
    );
  });

  it("host под каналом подписки не удаляется", async () => {
    const n = await node();
    const inbound = await infra.createInbound({
      configProfileId: n.configProfileId,
      tag: "VLESS_REALITY_DE",
      port: 443,
      ...REALITY,
    });
    const host = await infra.createHost({
      inboundId: inbound.id,
      nodeId: n.id,
      remark: "DE",
      address: "203.0.113.10",
      port: 443,
      pbk: "PBK",
      sid: "aa01",
      ...REALITY,
    });
    await db.insert(schema.channel).values({ orgId: TEST_ORG_ID, kind: "direct", tag: "de-direct", hostId: host.id });

    await assert.rejects(
      () => infra.deleteHost(host.id),
      (e) => status(e) === 409 && /канал/.test((e as Error).message),
    );
  });

  it("сервер с нодой и профиль с inbound'ом не удаляются", async () => {
    const n = await node();
    await assert.rejects(
      () => infra.deleteServer(n.serverId),
      (e) => status(e) === 409 && /ноды/.test((e as Error).message),
    );
    await infra.createInbound({ configProfileId: n.configProfileId, tag: "VLESS_X", port: 443, ...REALITY });
    await assert.rejects(
      () => infra.deleteConfigProfile(n.configProfileId),
      (e) => status(e) === 409,
    );
  });

  it("нода без ссылок удаляется вместе со своим состоянием", async () => {
    const n = await node();
    assert.deepEqual(await infra.deleteNode(n.id), { ok: true });
    const [left] = await db.select().from(schema.nodeDesiredState).where(eq(schema.nodeDesiredState.nodeId, n.id));
    assert.equal(left, undefined);
  });
});

describe("мастер «Добавить локацию»", () => {
  it("одним вызовом поднимает сервер→профиль→ноду→inbound→host и сразу даёт desired-state", async () => {
    const result = await infra.provisionLocation({
      name: "de1-exit",
      primaryIp: "203.0.113.10",
      country: "DE",
      sni: "ads.x5.ru",
    });

    assert.equal(result.server.created, true);
    assert.equal(result.node.created, true);
    assert.equal(result.inbound.created, true);
    assert.equal(result.host.created, true);
    assert.equal(result.inbound.label, "VLESS_REALITY_DE1-EXIT");
    assert.equal(result.rebuilt.length, 1);
    assert.equal(result.rebuilt[0].changed, true);

    // desired-state собран сразу и содержит наш inbound (плюс служебный api)
    assert.deepEqual(await inboundTags(result.node.id), ["VLESS_REALITY_DE1-EXIT", "api"].sort());

    // host привязан к inbound и ноде; pbk пустой — ключ приедет при энроллменте
    const [host] = await db.select().from(schema.host).where(eq(schema.host.id, result.host.id));
    assert.equal(host.nodeId, result.node.id);
    assert.equal(host.inboundId, result.inbound.id);
    assert.equal(host.address, "203.0.113.10");
    assert.equal(host.pbk, null);
  });

  it("повторный прогон идемпотентен: ничего не дублирует и не затирает", async () => {
    const body = { name: "fi1-exit", primaryIp: "203.0.113.20", sni: "ads.x5.ru" };
    const first = await infra.provisionLocation(body);
    const second = await infra.provisionLocation(body);

    assert.equal(second.server.created, false);
    assert.equal(second.node.created, false);
    assert.equal(second.inbound.created, false);
    assert.equal(second.host.created, false);
    assert.equal(first.node.id, second.node.id);

    const servers = await db.select().from(schema.server).where(eq(schema.server.hostname, "203.0.113.20"));
    assert.equal(servers.length, 1, "второй прогон не должен заводить второй сервер");
  });

  it("привязывает inbound к squad'у, и подписчик squad'а появляется в desired-state", async () => {
    const squad = await infra.createSquad({ name: "базовый" });
    const subscriber = await createSubscriber(db);
    const subscription = await createSubscription(db, subscriber.id);
    await db.insert(schema.subscriptionSquad).values({ subscriptionId: subscription.id, squadId: squad.id });

    const result = await infra.provisionLocation({
      name: "de2-exit",
      primaryIp: "203.0.113.11",
      sni: "ads.x5.ru",
      squadIds: [squad.id],
    });

    assert.equal(result.squads.length, 1);
    assert.equal(result.squads[0].attached, true);

    const desired = await state.getDesiredState(result.node.id);
    assert.ok(
      desired.users.some((u) => u.uuid === subscription.vlessUuid),
      "подписчик привязанного squad'а должен быть в desired-state ноды",
    );
  });

  it("security=reality без sni отвергается на входе, а не сборкой конфига", async () => {
    await assert.rejects(
      () => infra.provisionLocation({ name: "no-sni", primaryIp: "203.0.113.12" }),
      (e) => status(e) === 400 && /sni/.test((e as Error).message),
    );
  });

  it("несуществующий squad отвергается", async () => {
    await assert.rejects(
      () =>
        infra.provisionLocation({
          name: "bad-squad",
          primaryIp: "203.0.113.13",
          sni: "ads.x5.ru",
          squadIds: ["11111111-1111-1111-1111-111111111111"],
        }),
      (e) => status(e) === 400 && /squad/.test((e as Error).message),
    );
  });
});

describe("секреты наружу не отдаются", () => {
  it("ssh_ref не попадает в список серверов", async () => {
    await server({ sshRef: "vault://projects/vpn/ssh/de1" });
    const [row] = await infra.listServers();
    assert.equal("sshRef" in row, false);
    assert.equal(row.hasSshRef, true);
  });

  it("reality_privkey_ref и raw_json не попадают в список inbound'ов", async () => {
    const n = await node();
    await infra.createInbound({
      configProfileId: n.configProfileId,
      tag: "VLESS_REALITY_DE",
      port: 443,
      realityPrivkeyRef: "vault://projects/vpn/reality/de1",
      ...REALITY,
    });
    const [row] = await infra.listInbounds();
    assert.equal("realityPrivkeyRef" in row, false);
    assert.equal("rawJson" in row, false);
    assert.equal(row.hasRealityPrivkeyRef, true);
  });
});
