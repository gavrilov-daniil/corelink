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
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { isEncrypted } from "@corelink/core-kit";
import {
  TEST_ORG_ID,
  cleanupOrg,
  closeDb,
  createPlan,
  createSubscriber,
  createSubscription,
  openDb,
} from "../testing/fixtures.test.js";
import { NodeStateService } from "./node-state.service.js";
import { InfraService } from "./infra.service.js";
import { locationChannelTag } from "./location-delivery.js";

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

    // без общего: иначе подписчик попал бы на ноду через него и привязку не проверили бы
    const result = await infra.provisionLocation({
      name: "de2-exit",
      primaryIp: "203.0.113.11",
      sni: "ads.x5.ru",
      squadIds: [squad.id],
      inGeneral: false,
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

  it("ssh_secret не отдаётся наружу — только признак hasSshSecret", async () => {
    const created = await server({ sshAuthType: "password", sshUser: "root", sshPassword: "s3cret" });
    assert.equal("sshSecret" in created, false);
    assert.equal(created.hasSshSecret, true);
    assert.equal(created.sshAuthType, "password");
    assert.equal(created.sshUser, "root");
    const [listed] = await infra.listServers();
    assert.equal("sshSecret" in listed, false);
    assert.equal(listed.hasSshSecret, true);
  });

  it("пароль лежит в БД зашифрованным, не текстом", async () => {
    const created = await server({ sshAuthType: "password", sshPassword: "s3cret" });
    const [row] = await db.select().from(schema.server).where(eq(schema.server.id, created.id)).limit(1);
    assert.equal(isEncrypted(row.sshSecret.password), true);
    assert.notEqual(row.sshSecret.password, "s3cret");
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

describe("SSH-доступ", () => {
  async function stored(id: string) {
    const [row] = await db.select().from(schema.server).where(eq(schema.server.id, id)).limit(1);
    return row;
  }

  it("неизвестный тип доступа отвергается", async () => {
    await assert.rejects(() => server({ sshAuthType: "telnet" }), (e) => status(e) === 400);
  });

  it("невалидный ssh-пользователь отвергается", async () => {
    await assert.rejects(
      () => server({ sshAuthType: "password", sshUser: "root; rm -rf /", sshPassword: "x" }),
      (e) => status(e) === 400,
    );
  });

  it("смена типа доступа чистит неактуальный секрет", async () => {
    const created = await server({ sshAuthType: "password", sshPassword: "s3cret" });
    await infra.updateServer(created.id, { sshAuthType: "key", sshPrivateKey: "KEYDATA" });
    const row = await stored(created.id);
    assert.equal("password" in row.sshSecret, false);
    assert.equal(isEncrypted(row.sshSecret.privateKey), true);
    assert.equal(row.sshAuthType, "key");
  });

  it("пустая строка секрета при правке удаляет ключ", async () => {
    const created = await server({ sshAuthType: "password", sshPassword: "s3cret" });
    await infra.updateServer(created.id, { sshPassword: "" });
    const row = await stored(created.id);
    assert.equal("password" in row.sshSecret, false);
  });

  it("правка hostname не трогает секрет", async () => {
    const created = await server({ sshAuthType: "password", sshPassword: "s3cret" });
    await infra.updateServer(created.id, { hostname: "renamed.example.com" });
    const row = await stored(created.id);
    assert.equal(isEncrypted(row.sshSecret.password), true);
  });

  it("проверка vault_ref не ходит по сети и пишет результат", async () => {
    const created = await server({ sshAuthType: "vault_ref", sshRef: "vault://x" });
    const result = await infra.sshCheck(created.id);
    assert.equal(result.ok, false);
    assert.match(result.detail, /vault/);
    const row = await stored(created.id);
    assert.equal(row.sshLastCheckOk, false);
    assert.notEqual(row.sshLastCheckAt, null);
  });

  it("проверка password без пароля — «не задан», без коннекта", async () => {
    const created = await server({ sshAuthType: "password", sshUser: "root" });
    const result = await infra.sshCheck(created.id);
    assert.equal(result.ok, false);
    assert.match(result.detail, /не задан/);
  });
});

describe("удаление локации", () => {
  it("сносит сервер, ноду, профиль, inbound и host целиком", async () => {
    const res = await infra.provisionLocation({
      name: `loc-${Math.random().toString(36).slice(2, 8)}`,
      primaryIp: "203.0.113.20",
      sni: "ads.x5.ru",
    });

    const del = await infra.deleteLocation(res.server.id);
    assert.equal(del.ok, true);
    assert.equal(del.removedNodes, 1);

    assert.equal((await db.select().from(schema.server).where(eq(schema.server.id, res.server.id))).length, 0);
    assert.equal((await db.select().from(schema.node).where(eq(schema.node.id, res.node.id))).length, 0);
    assert.equal((await db.select().from(schema.inbound).where(eq(schema.inbound.id, res.inbound.id))).length, 0);
    assert.equal((await db.select().from(schema.host).where(eq(schema.host.id, res.host.id))).length, 0);
  });

  it("не сносит локацию, на ноду которой уже пришёл трафик", async () => {
    const res = await infra.provisionLocation({
      name: `loc-${Math.random().toString(36).slice(2, 8)}`,
      primaryIp: "203.0.113.21",
      sni: "ads.x5.ru",
    });
    await db.insert(schema.trafficReport).values({ orgId: TEST_ORG_ID, nodeId: res.node.id, reportId: "1:1" });

    await assert.rejects(() => infra.deleteLocation(res.server.id), (e) => status(e) === 409);
    assert.equal((await db.select().from(schema.server).where(eq(schema.server.id, res.server.id))).length, 1);
  });
});

describe("выдача локации клиентам (тир и профили)", () => {
  /** Членство канала локации в профилях: [имя профиля, тир], по имени. */
  async function memberships(nodeId: string): Promise<Array<[string, number]>> {
    const rows = await db
      .select({ remark: schema.profile.remark, tier: schema.profileChannel.tier })
      .from(schema.profileChannel)
      .innerJoin(schema.channel, eq(schema.channel.id, schema.profileChannel.channelId))
      .innerJoin(schema.profile, eq(schema.profile.id, schema.profileChannel.profileId))
      .where(eq(schema.channel.tag, locationChannelTag(nodeId)));
    return rows.map((r): [string, number] => [r.remark, r.tier]).sort((a, b) => a[0].localeCompare(b[0]));
  }

  const provision = (extra: Record<string, unknown> = {}) =>
    infra.provisionLocation({
      name: "de-exit",
      primaryIp: "203.0.113.30",
      sni: "ads.x5.ru",
      country: "DE",
      ...extra,
    });

  it("выходная локация сразу попадает в «Авто» и профиль страны с выбранным тиром", async () => {
    const res = await provision({ tier: 2 });

    assert.deepEqual(res.delivery?.profiles, ["🔀 Авто", "🇩🇪 Германия"]);
    assert.deepEqual(await memberships(res.node.id), [
      ["🇩🇪 Германия", 2],
      ["🔀 Авто", 2],
    ]);
  });

  it("исключение: без галочки «Авто» локация есть только в профиле страны", async () => {
    const res = await provision({ inAuto: false });
    assert.deepEqual(await memberships(res.node.id), [["🇩🇪 Германия", 1]]);
  });

  it("повторный мастер не плодит ни канал, ни профили, ни привязки", async () => {
    await provision();
    const res = await provision();

    const channels = await db.select().from(schema.channel).where(eq(schema.channel.tag, locationChannelTag(res.node.id)));
    const profiles = await db.select().from(schema.profile).where(eq(schema.profile.orgId, TEST_ORG_ID));
    assert.equal(channels.length, 1);
    assert.equal(profiles.length, 2, "«Авто» и «Германия» — по одному");
    assert.equal((await memberships(res.node.id)).length, 2);
  });

  it("relay-нода в выдачу не попадает: это плечо каскада, прямого канала у неё нет", async () => {
    const res = await provision({ roles: ["relay"] });

    assert.equal(res.delivery, null);
    const channels = await db.select().from(schema.channel).where(eq(schema.channel.tag, locationChannelTag(res.node.id)));
    assert.equal(channels.length, 0);
  });

  it("тир вне 1..3 отвергается на границе", async () => {
    await assert.rejects(() => provision({ tier: 4 }), (e) => status(e) === 400);
  });

  it("правка выдачи: смена тира и исключение из профиля страны", async () => {
    const res = await provision({ tier: 1 });
    await infra.setLocationDelivery(res.server.id, { tier: 3, inAuto: true, inCountry: false });
    assert.deepEqual(await memberships(res.node.id), [["🔀 Авто", 3]]);

    // и обратно: вернуть в профиль страны
    await infra.setLocationDelivery(res.server.id, { tier: 3, inAuto: true, inCountry: true });
    assert.deepEqual(await memberships(res.node.id), [
      ["🇩🇪 Германия", 3],
      ["🔀 Авто", 3],
    ]);
  });

  it("удаление локации уносит её канал и привязки, общие профили остаются", async () => {
    const res = await provision();
    await infra.deleteLocation(res.server.id);

    const channels = await db.select().from(schema.channel).where(eq(schema.channel.tag, locationChannelTag(res.node.id)));
    assert.equal(channels.length, 0);
    const links = await db.select().from(schema.profileChannel).where(eq(schema.profileChannel.orgId, TEST_ORG_ID));
    assert.equal(links.length, 0);
    const profiles = await db.select().from(schema.profile).where(eq(schema.profile.orgId, TEST_ORG_ID));
    assert.equal(profiles.length, 2, "в профилях могут быть другие локации — их не трогаем");
  });

  it("состояние выдачи для списка локаций", async () => {
    const res = await provision({ tier: 2, inCountry: false });
    const state = (await infra.listLocationDelivery()).find((s) => s.nodeId === res.node.id);

    assert.deepEqual(state, {
      nodeId: res.node.id,
      wired: true,
      tier: 2,
      inAuto: true,
      inCountry: false,
      countryProfile: "🇩🇪 Германия",
    });
  });
});

describe("доступ к локации: общий и свои squad'ы", () => {
  const DAY_MS = 86_400_000;

  const provision = (extra: Record<string, unknown> = {}) =>
    infra.provisionLocation({
      name: `loc-${Math.random().toString(36).slice(2, 8)}`,
      primaryIp: "203.0.113.40",
      sni: "ads.x5.ru",
      country: "DE",
      ...extra,
    });

  async function userUuids(nodeId: string): Promise<string[]> {
    return (await state.getDesiredState(nodeId)).users.map((u) => u.uuid);
  }

  const generalSquads = () =>
    db.select().from(schema.squad).where(and(eq(schema.squad.orgId, TEST_ORG_ID), eq(schema.squad.forAll, true)));

  const squadLinks = (squadId: string) =>
    db.select().from(schema.squadInbound).where(eq(schema.squadInbound.squadId, squadId));

  it("мастер кладёт локацию в общий squad: её получают все активные подписки без строк subscription_squad", async () => {
    const active = await createSubscription(db, (await createSubscriber(db)).id);
    const expired = await createSubscription(db, (await createSubscriber(db)).id, {
      expireAt: new Date(Date.now() - DAY_MS),
    });

    const res = await provision();

    assert.deepEqual(
      res.squads.map((s) => [s.name, s.forAll, s.attached]),
      [["Общий", true, true]],
    );
    const users = await userUuids(res.node.id);
    assert.ok(users.includes(active.vlessUuid), "общий squad пускает подписку без явного членства");
    assert.ok(!users.includes(expired.vlessUuid), "истёкшая подписка на ноду не выгружается");
    const memberships = await db
      .select()
      .from(schema.subscriptionSquad)
      .where(eq(schema.subscriptionSquad.subscriptionId, active.id));
    assert.equal(memberships.length, 0, "членство в общем подразумевается флагом, строк нет");
  });

  it("исключение: без галочки «Общий» локация закрыта для всех", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id);
    const res = await provision({ inGeneral: false });

    assert.deepEqual(res.squads, []);
    assert.equal((await userUuids(res.node.id)).includes(sub.vlessUuid), false);
  });

  it("общий squad в org один: второй мастер находит его, а не заводит новый", async () => {
    await provision({ primaryIp: "203.0.113.41" });
    await provision({ primaryIp: "203.0.113.42" });

    const general = await generalSquads();
    assert.equal(general.length, 1);
    assert.equal((await squadLinks(general[0].id)).length, 2);
  });

  it("«Выдача»: снял общий и выбрал свой squad — на ноде остаются только его подписчики", async () => {
    const res = await provision();
    const premium = await infra.createSquad({ name: "Премиум" });
    const basic = await createSubscription(db, (await createSubscriber(db)).id);
    const vip = await createSubscription(db, (await createSubscriber(db)).id);
    await db.insert(schema.subscriptionSquad).values({ subscriptionId: vip.id, squadId: premium.id });

    const saved = await infra.setLocationDelivery(res.server.id, { tier: 1, inGeneral: false, squadIds: [premium.id] });
    assert.equal(saved.rebuilt[0]?.changed, true, "состав squad'ов — это клиенты на ноде: версия обязана подняться");
    const users = await userUuids(res.node.id);
    assert.ok(users.includes(vip.vlessUuid));
    assert.ok(!users.includes(basic.vlessUuid));

    // и обратно: общий вернул, свой снял — снова все, а в «Премиум» локации больше нет
    await infra.setLocationDelivery(res.server.id, { tier: 1, inGeneral: true, squadIds: [] });
    const back = await userUuids(res.node.id);
    assert.ok(back.includes(basic.vlessUuid) && back.includes(vip.vlessUuid));
    assert.equal((await squadLinks(premium.id)).length, 0);
  });

  it("правка выдачи без полей доступа squad'ы не трогает и ноду не пересобирает", async () => {
    const res = await provision();
    const saved = await infra.setLocationDelivery(res.server.id, { tier: 2 });

    assert.deepEqual(saved.rebuilt, []);
    const [general] = await generalSquads();
    assert.equal((await squadLinks(general.id)).length, 1);
  });

  it("squad собирается из локаций: nodeIds → входы нод, вход профиля без ноды сохраняется", async () => {
    const res = await provision();
    const orphanProfile = await profile();
    const orphan = await infra.createInbound({
      configProfileId: orphanProfile.id,
      tag: "VLESS_REALITY_ORPHAN",
      port: 443,
      ...REALITY,
    });
    const squad = await infra.createSquad({ name: "Сборный", inboundIds: [orphan.id] });

    const updated = await infra.updateSquad(squad.id, { nodeIds: [res.node.id] });
    assert.deepEqual([...updated.inboundIds].sort(), [orphan.id, res.inbound.id].sort());

    const cleared = await infra.updateSquad(squad.id, { nodeIds: [] });
    assert.deepEqual(cleared.inboundIds, [orphan.id], "вход без ноды простой режим не показывает — и не сносит");
  });

  it("общий squad правится и до первой локации; повторно находится по флагу, а не по имени", async () => {
    const n = await node();
    await infra.createInbound({ configProfileId: n.configProfileId, tag: "VLESS_REALITY_GEN", port: 443, ...REALITY });

    const general = await infra.updateGeneralSquad({ name: "Все клиенты", nodeIds: [n.id] });
    assert.equal(general.forAll, true);
    assert.equal(general.name, "Все клиенты");

    const again = await infra.updateGeneralSquad({ nodeIds: [n.id] });
    assert.equal(again.id, general.id);
    assert.equal((await generalSquads()).length, 1);
  });

  it("общий squad не удаляется", async () => {
    await provision();
    const [general] = await generalSquads();
    await assert.rejects(() => infra.deleteSquad(general.id), (e) => status(e) === 409);
  });

  it("имя squad'а уникально: дубль при создании и при переименовании — 409", async () => {
    await infra.createSquad({ name: "Премиум" });
    const other = await infra.createSquad({ name: "Базовый" });

    await assert.rejects(() => infra.createSquad({ name: "Премиум" }), (e) => status(e) === 409);
    await assert.rejects(() => infra.updateSquad(other.id, { name: "Премиум" }), (e) => status(e) === 409);
  });

  it("обычный squad с именем «Общий» не даёт завести общий — понятный 409, а не 500", async () => {
    await infra.createSquad({ name: "Общий" });
    await assert.rejects(
      () => provision(),
      (e) => status(e) === 409 && /переименуйте/.test((e as Error).message),
    );
  });

  it("список: общий первым, у своих — тарифы, которые их выдают", async () => {
    await provision();
    const premium = await infra.createSquad({ name: "Премиум" });
    await createPlan(db, { code: `year-${Math.random().toString(36).slice(2, 6)}`, squadIds: [premium.id] });

    const list = await infra.listSquads();
    assert.deepEqual(
      list.map((s) => [s.name, s.forAll]),
      [
        ["Общий", true],
        ["Премиум", false],
      ],
    );
    assert.equal(list[1].plans.length, 1);
    assert.equal(list[0].plans.length, 0);
  });
});
