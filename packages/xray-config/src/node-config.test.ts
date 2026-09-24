import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNodeConfig, configHash, canonicalJson, deterministicUuid } from "./node-config.js";
import type { CascadeOutbound, NodeConfigInput } from "./node-config.js";

const reality = { publicKey: "PBK", shortIds: ["aa11", "bb22"], sni: "ads.x5.ru", fingerprint: "firefox" };

function exitNode(): NodeConfigInput {
  return {
    role: "exit",
    inbounds: [{ tag: "VLESS_REALITY_DE", port: 443, role: "exit", reality, flow: "xtls-rprx-vision" }],
    users: [
      { email: "user-b@vpn", uuid: "22222222-2222-2222-2222-222222222222", inboundTag: "VLESS_REALITY_DE" },
      { email: "user-a@vpn", uuid: "11111111-1111-1111-1111-111111111111", inboundTag: "VLESS_REALITY_DE" },
    ],
  };
}

const cascade: CascadeOutbound = {
  tag: "CASCADE_FI",
  cc: "FI",
  fromInboundTag: "ru2_RELAY_IN",
  exit: { address: "203.0.113.5", port: 443, uuid: "33333333-3333-3333-3333-333333333333", reality, flow: "xtls-rprx-vision" },
};

test("exit-нода: reality-inbound, api/stats/policy для сбора трафика", () => {
  const cfg = buildNodeConfig(exitNode()) as any;
  const inbound = cfg.inbounds.find((i: any) => i.tag === "VLESS_REALITY_DE");
  assert.equal(inbound.protocol, "vless");
  assert.equal(inbound.streamSettings.security, "reality");
  assert.equal(inbound.sniffing.routeOnly, true, "routeOnly обязателен, иначе рвётся Vision");
  assert.deepEqual(cfg.api.services, ["HandlerService", "StatsService", "LoggerService"]);
  assert.equal(cfg.policy.levels["0"].statsUserUplink, true);
  assert.ok(cfg.inbounds.some((i: any) => i.tag === "api" && i.listen === "127.0.0.1"));
});

test("приватный ключ Reality НЕ попадает в конфиг из панели (подставляет агент)", () => {
  const cfg = buildNodeConfig(exitNode()) as any;
  const rs = cfg.inbounds[0].streamSettings.realitySettings;
  assert.equal(rs.privateKey, "__REALITY_PRIVATE_KEY__");
  assert.ok(!JSON.stringify(cfg).includes("PRIVKEY"));
});

test("CDN-нода: security=none + grpc + serviceName, без reality-настроек (TLS терминирует CDN)", () => {
  const cfg = buildNodeConfig({
    role: "exit",
    inbounds: [
      { tag: "CDN_DE", port: 443, role: "exit", reality, network: "grpc", security: "none", serviceName: "grpcsvc", flow: "" },
    ],
    users: [],
  }) as any;
  const inbound = cfg.inbounds.find((i: any) => i.tag === "CDN_DE");
  assert.equal(inbound.streamSettings.network, "grpc");
  assert.equal(inbound.streamSettings.security, "none");
  assert.equal(inbound.streamSettings.grpcSettings.serviceName, "grpcsvc");
  assert.ok(!inbound.streamSettings.realitySettings, "для security=none reality-настроек быть не должно");
});

test("анти-абьюз в конфиге ноды: bittorrent и SMTP в block", () => {
  const cfg = buildNodeConfig(exitNode()) as any;
  const rules = cfg.routing.rules;
  assert.ok(rules.some((r: any) => r.protocol?.includes("bittorrent") && r.outboundTag === "block"));
  assert.ok(rules.some((r: any) => r.port === "25" && r.outboundTag === "block"));
});

test("приватная сеть ноды и локальный gRPC API закрыты от клиента", () => {
  const cfg = buildNodeConfig(exitNode()) as any;
  const blockPrivate = cfg.routing.rules.find((r: any) => Array.isArray(r.ip) && r.outboundTag === "block");
  assert.ok(blockPrivate, "нет правила блокировки приватных назначений");
  for (const cidr of ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7", "fe80::/10"]) {
    assert.ok(blockPrivate.ip.includes(cidr), `диапазон ${cidr} не закрыт`);
  }
});

test("порядок правил: api-инбаунд ПЕРЕД блокировкой 127/8, иначе умрёт сбор статистики", () => {
  const cfg = buildNodeConfig(exitNode()) as any;
  const rules = cfg.routing.rules;
  assert.deepEqual(rules[0], { type: "field", inboundTag: ["api"], outboundTag: "api" });
  assert.equal(rules[1].outboundTag, "block");
  assert.ok(rules[1].ip.includes("127.0.0.0/8"));
});

test("relay: правило форварда каскада идёт ПОСЛЕ блокировки приватных сетей", () => {
  const cfg = buildNodeConfig({
    role: "relay",
    inbounds: [{ tag: "ru2_RELAY_IN", port: 443, role: "relay", reality, flow: "xtls-rprx-vision" }],
    users: [],
    cascades: [cascade],
  }) as any;
  const rules: any[] = cfg.routing.rules;
  const blockIdx = rules.findIndex((r) => Array.isArray(r.ip) && r.outboundTag === "block");
  const fwdIdx = rules.findIndex((r) => r.outboundTag === "CASCADE_FI");
  assert.ok(blockIdx >= 0 && fwdIdx > blockIdx, "каскад не должен утаскивать приватные назначения в exit");
});

test("relay: server-forward каскад = outbound CASCADE_<CC> + правило inbound→outbound", () => {
  const cfg = buildNodeConfig({
    role: "relay",
    inbounds: [{ tag: "ru2_RELAY_IN", port: 443, role: "relay", reality, flow: "xtls-rprx-vision" }],
    users: [],
    cascades: [cascade],
  }) as any;

  const out = cfg.outbounds.find((o: any) => o.tag === "CASCADE_FI");
  assert.equal(out.settings.vnext[0].address, "203.0.113.5");
  assert.equal(out.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
  const rule = cfg.routing.rules.find((r: any) => r.inboundTag?.includes("ru2_RELAY_IN") && r.outboundTag === "CASCADE_FI");
  assert.ok(rule, "нет правила форварда relay→exit");
});

test("детерминизм: порядок юзеров и полей не влияет на config_hash", () => {
  const a = buildNodeConfig(exitNode());
  const reversed = exitNode();
  reversed.users = [...reversed.users].reverse();
  const b = buildNodeConfig(reversed);
  assert.equal(configHash(a), configHash(b), "hash обязан совпасть — иначе агент будет рестартовать Xray впустую");
});

test("hash меняется при реальном изменении (добавили юзера)", () => {
  const base = buildNodeConfig(exitNode());
  const changed = exitNode();
  changed.users.push({ email: "new@vpn", uuid: "44444444-4444-4444-4444-444444444444", inboundTag: "VLESS_REALITY_DE" });
  assert.notEqual(configHash(base), configHash(buildNodeConfig(changed)));
});

test("canonicalJson не зависит от порядка ключей", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] }), canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
});

test("link-user каскада детерминирован (uuid v5), повтор раскатки не плодит юзеров", () => {
  const a = deterministicUuid("cascade", "link-1");
  const b = deterministicUuid("cascade", "link-1");
  assert.equal(a, b);
  assert.notEqual(a, deterministicUuid("cascade", "link-2"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("клиенты inbound'а отсортированы — стабильный порядок в конфиге", () => {
  const cfg = buildNodeConfig(exitNode()) as any;
  const emails = cfg.inbounds[0].settings.clients.map((c: any) => c.email);
  assert.deepEqual(emails, ["user-a@vpn", "user-b@vpn"]);
});
