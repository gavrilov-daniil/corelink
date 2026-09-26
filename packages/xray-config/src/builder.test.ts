import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBase, buildProfileConfig, projectVariants } from "./builder.js";
import { validateConfig } from "./validate.js";
import type { GeneratorInput, ProfileInput } from "./types.js";

function fixture(): GeneratorInput {
  const reality = { sni: "ads.x5.ru", fingerprint: "firefox", flow: "xtls-rprx-vision" };
  return {
    vlessUuid: "11111111-1111-1111-1111-111111111111",
    front: {
      tag: "frontru2",
      host: { address: "10.0.0.9", port: 8443, pbk: "PBK_FRONT", sid: "aa11", ...reality },
    },
    domainList: {
      zones: ["ru", "su", "xn--p1ai"],
      domains: ["domain:vk.com", "domain:yandex.ru"],
      ipCidrs: ["77.88.0.0/18"],
    },
    channels: [
      { kind: "direct", tag: "de-direct", cc: "DE", host: { address: "1.1.1.1", port: 443, pbk: "PBK_DE", sid: "de01", ...reality } },
      { kind: "direct", tag: "pl-direct", cc: "PL", host: { address: "2.2.2.2", port: 443, pbk: "PBK_PL", sid: "pl01", ...reality } },
      { kind: "cascade", tag: "pl-cascade", cc: "PL", host: { address: "2.2.2.2", port: 443, pbk: "PBK_PL", sid: "pl01", ...reality } },
    ],
  };
}

test("assembleBase проходит инвариант-валидатор", () => {
  const cfg = assembleBase(fixture());
  const res = validateConfig(cfg);
  assert.deepEqual(res.errors, []);
  assert.ok(res.ok);
});

test("reality-канал без pbk валидатор не пропускает: XrayCore клиента не стартует на всём конфиге", () => {
  const input = fixture();
  input.channels[0] = { ...input.channels[0]!, host: { ...input.channels[0]!.host, pbk: "" } };
  const res = validateConfig(assembleBase(input));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('"de-direct"') && e.includes("publicKey")), res.errors.join("; "));
});

test("CDN-канал: клиентский outbound tls + grpc + serviceName, без reality-настроек", () => {
  const input: GeneratorInput = {
    vlessUuid: "11111111-1111-1111-1111-111111111111",
    domainList: { zones: [], domains: [] },
    channels: [
      {
        kind: "direct",
        tag: "cdn-de",
        cc: "DE",
        host: {
          address: "cdn.example.com",
          port: 443,
          sni: "cdn.example.com",
          fingerprint: "firefox",
          pbk: "",
          sid: "",
          flow: "",
          network: "grpc",
          security: "tls",
          serviceName: "grpcsvc",
        },
      },
    ],
  };
  const profile: ProfileInput = { remark: "CDN", primary: ["cdn-de"], fallback: [] };
  const cfg = buildProfileConfig(input, profile) as any;
  const out = cfg.outbounds.find((o: any) => o.tag === "cdn-de");
  assert.equal(out.streamSettings.security, "tls");
  assert.equal(out.streamSettings.network, "grpc");
  assert.equal(out.streamSettings.grpcSettings.serviceName, "grpcsvc");
  assert.ok(out.streamSettings.tlsSettings, "tlsSettings должны быть");
  assert.ok(!out.streamSettings.realitySettings, "для tls reality-настроек быть не должно");
});

test("три эшелона: tier1 → tier2 → tier3 цепочкой loopback, последний без fallbackTag", () => {
  const profile: ProfileInput = {
    remark: "🔀 Авто",
    primary: ["de-direct"],
    fallback: ["pl-direct"],
    reserve: ["pl-cascade"],
  };
  const cfg = buildProfileConfig(fixture(), profile) as any;
  const [t1, t2, t3] = cfg.routing.balancers;
  assert.deepEqual(
    [t1.tag, t2.tag, t3.tag],
    ["tier1", "tier2", "tier3"],
  );
  assert.equal(t1.fallbackTag, "lo-out-1");
  assert.equal(t2.fallbackTag, "lo-out-2");
  assert.equal(t3.fallbackTag, undefined, "последний эшелон — без перехода, иначе петля");
  assert.equal(t1.strategy.type, "leastPing");
  assert.equal(t2.strategy.type, "leastPing", "промежуточный эшелон с переходом обязан быть leastPing");
  assert.equal(t3.strategy.type, "random");
  const reinject = cfg.routing.rules.filter((r: any) => r.inboundTag?.[0]?.startsWith("lo-in-"));
  assert.deepEqual(
    reinject.map((r: any) => [r.inboundTag[0], r.balancerTag]),
    [
      ["lo-in-1", "tier2"],
      ["lo-in-2", "tier3"],
    ],
  );
  const res = validateConfig(cfg);
  assert.deepEqual(res.errors, []);
});

test("пустой средний эшелон схлопывается: tier1 → tier3 становится tier1 → tier2", () => {
  const cfg = buildProfileConfig(fixture(), {
    remark: "PL",
    primary: ["pl-direct"],
    fallback: [],
    reserve: ["pl-cascade"],
  }) as any;
  assert.deepEqual(
    cfg.routing.balancers.map((b: any) => b.tag),
    ["tier1", "tier2"],
  );
  assert.ok(validateConfig(cfg).ok);
});

test("двухтирный профиль: loopback-цепочка целостна, последний tier без fallbackTag", () => {
  const input = fixture();
  const profile: ProfileInput = { remark: "🇵🇱 Польша", primary: ["pl-direct"], fallback: ["pl-cascade"] };
  const cfg = buildProfileConfig(input, profile) as any;
  assert.equal(validateConfig(cfg).ok, true);

  const tier1 = cfg.routing.balancers.find((b: any) => b.tag === "tier1");
  const tier2 = cfg.routing.balancers.find((b: any) => b.tag === "tier2");
  assert.equal(tier1.fallbackTag, "lo-out-1");
  assert.equal(tier2.fallbackTag, undefined); // последний tier — без fallback
  assert.ok(cfg.inbounds.some((i: any) => i.tag === "lo-in-1" && i.port === 0 && i.listen === "127.0.0.1"));
});

test("single-tier профиль (только каскады, как FI) — балансер без fallback, без loopback", () => {
  const input = fixture();
  // два канала: с одним балансер не создаётся вовсе (см. отдельный тест про «Россию»)
  const profile: ProfileInput = { remark: "🇫🇮 Финляндия", primary: ["pl-cascade", "de-direct"], fallback: [] };
  const cfg = buildProfileConfig(input, profile) as any;
  assert.equal(validateConfig(cfg).ok, true);
  assert.equal(cfg.routing.balancers.length, 1);
  assert.equal(cfg.routing.balancers[0].fallbackTag, undefined);
  assert.ok(!cfg.inbounds.some((i: any) => i.tag === "lo-in-1"));
});

test("cascade-канал несёт dialerProxy=front, оба плеча flow=vision", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, { remark: "PL", primary: ["pl-direct"], fallback: ["pl-cascade"] }) as any;
  const clone = cfg.outbounds.find((o: any) => o.tag === "pl-cascade");
  const front = cfg.outbounds.find((o: any) => o.tag === "frontru2");
  assert.equal(clone.streamSettings.sockopt.dialerProxy, "frontru2");
  assert.equal(clone.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
  assert.equal(front.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
});

test("валидатор ловит geoip: в конфиге", () => {
  const cfg = assembleBase(fixture()) as any;
  cfg.routing.rules.push({ type: "field", ip: ["geoip:ru"], outboundTag: "freedom" });
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("geoip")));
});

test("валидатор ловит последний tier с fallbackTag (петля реинжекта)", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, { remark: "PL", primary: ["pl-direct"], fallback: ["pl-cascade"] }) as any;
  cfg.routing.balancers.find((b: any) => b.tag === "tier2").fallbackTag = "lo-out-1";
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
});

test("ruSplit по умолчанию: РФ-домены и РФ-CIDR идут в freedom, DNS разведён на РФ-резолвер", () => {
  const cfg = buildProfileConfig(fixture(), { remark: "🇩🇪 Германия", primary: ["de-direct", "pl-direct"], fallback: [] }) as any;
  assert.ok(cfg.routing.rules.some((r: any) => Array.isArray(r.domain) && r.domain.includes("domain:ru")));
  assert.ok(cfg.routing.rules.some((r: any) => Array.isArray(r.ip) && r.ip.includes("77.88.0.0/18")));
  assert.equal(cfg.dns.servers.length, 3); // РФ DoH + зарубежный DoH + plain-fallback (как в боевой выдаче)
  assert.deepEqual(validateConfig(cfg).errors, []);
});

test("ruSplit=false: РФ-правил и РФ-резолвера нет, конфиг остаётся валидным", () => {
  const profile: ProfileInput = { remark: "🇷🇺 Россия", primary: ["de-direct", "pl-direct"], fallback: [], ruSplit: false };
  const cfg = buildProfileConfig(fixture(), profile) as any;
  assert.ok(!cfg.routing.rules.some((r: any) => Array.isArray(r.domain)));
  assert.ok(!cfg.routing.rules.some((r: any) => Array.isArray(r.ip) && r.ip.includes("77.88.0.0/18")));
  // приватные сети мимо туннеля остаются всегда
  assert.ok(cfg.routing.rules.some((r: any) => Array.isArray(r.ip) && r.ip.includes("10.0.0.0/8")));
  assert.deepEqual(cfg.dns.servers, ["https://dns.google/dns-query", "1.1.1.1"]);
  assert.equal(cfg.dns.queryStrategy, "UseIPv4");
  assert.deepEqual(validateConfig(cfg).errors, []);
});

test("валидатор ловит перестановку head-правил (РФ раньше приватных сетей)", () => {
  const cfg = assembleBase(fixture()) as any;
  const rules = cfg.routing.rules as any[];
  const privIdx = rules.findIndex((r) => Array.isArray(r.ip) && r.ip.includes("10.0.0.0/8"));
  const ruIdx = rules.findIndex((r) => Array.isArray(r.domain));
  [rules[privIdx], rules[ruIdx]] = [rules[ruIdx], rules[privIdx]];
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("порядок split-routing")));
});

test("валидатор ловит catch-all перед РФ-правилами и правила после catch-all", () => {
  const cfg = assembleBase(fixture()) as any;
  const rules = cfg.routing.rules as any[];
  rules.unshift(rules.pop()); // catch-all в начало
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("порядок split-routing")));
  assert.ok(res.errors.some((e) => e.includes("недостижимы")));
});

test("валидатор ловит потерю block-правил и catch-all", () => {
  const cfg = assembleBase(fixture()) as any;
  cfg.routing.rules = cfg.routing.rules.filter(
    (r: any) => r.outboundTag !== "block" && !(r.balancerTag && !r.inboundTag),
  );
  const errs = validateConfig(cfg).errors;
  assert.ok(errs.some((e) => e.includes("block udp:443")));
  assert.ok(errs.some((e) => e.includes("bittorrent")));
  assert.ok(errs.some((e) => e.includes("catch-all")));
});

test("валидатор требует sniffing.routeOnly на пользовательских inbound", () => {
  const cfg = assembleBase(fixture()) as any;
  assert.equal(validateConfig(cfg).ok, true);
  cfg.inbounds.find((i: any) => i.tag === "socks-in").sniffing = { enabled: true, destOverride: ["http", "tls"] };
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("routeOnly")));
});

test("валидатор требует dns.queryStrategy=UseIPv4", () => {
  const cfg = assembleBase(fixture()) as any;
  cfg.dns.queryStrategy = "UseIP";
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("UseIPv4")));
});

test("валидатор запрещает burstObservatory (баг Xray #5897)", () => {
  const cfg = assembleBase(fixture()) as any;
  cfg.burstObservatory = { subjectSelector: ["de-direct"] };
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("burstObservatory")));
});

test("валидатор требует strategy.type=leastPing у каждого балансера", () => {
  const cfg = assembleBase(fixture()) as any;
  cfg.routing.balancers[0].strategy = { type: "random" };
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("leastPing")));
});

test("валидатор требует https в observatory.probeUrl", () => {
  const input = fixture();
  assert.equal(validateConfig(assembleBase(input)).ok, true);
  const cfg = assembleBase({ ...input, probeUrl: "http://cp.cloudflare.com/generate_204" }) as any;
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("probeUrl")));
});

test("валидатор ловит потерю flow на любом плече каскада", () => {
  const input = fixture();
  const profile: ProfileInput = { remark: "PL", primary: ["pl-direct"], fallback: ["pl-cascade"] };

  const brokenClone = buildProfileConfig(input, profile) as any;
  brokenClone.outbounds.find((o: any) => o.tag === "pl-cascade").settings.vnext[0].users[0].flow = "";
  assert.ok(validateConfig(brokenClone).errors.some((e) => e.includes("pl-cascade")));

  const brokenFront = buildProfileConfig(input, profile) as any;
  brokenFront.outbounds.find((o: any) => o.tag === "frontru2").settings.vnext[0].users[0].flow = "";
  assert.ok(validateConfig(brokenFront).errors.some((e) => e.includes("frontru2")));
});

test("flow: пустой на tcp+reality — ошибка, на grpc пустой — норма", () => {
  const input = fixture();
  input.channels.push({
    kind: "direct",
    tag: "nl-grpc",
    cc: "NL",
    host: {
      address: "3.3.3.3", port: 443, sni: "ads.x5.ru", fingerprint: "firefox",
      pbk: "PBK_NL", sid: "nl01", flow: "", network: "grpc",
    },
  });

  const grpc = buildProfileConfig(input, { remark: "NL", primary: ["nl-grpc"], fallback: [] });
  assert.deepEqual(validateConfig(grpc).errors, []);

  const tcp = buildProfileConfig(input, { remark: "DE", primary: ["de-direct"], fallback: [] }) as any;
  tcp.outbounds.find((o: any) => o.tag === "de-direct").settings.vnext[0].users[0].flow = "";
  assert.ok(validateConfig(tcp).errors.some((e) => e.includes("Vision")));
});

test("валидатор ловит префиксную коллизию селекторов разных балансеров", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, { remark: "PL", primary: ["pl-direct"], fallback: ["pl-cascade"] }) as any;
  assert.equal(validateConfig(cfg).ok, true);

  // тег "pl" в tier1 префиксно захватывает и pl-cascade из tier2
  cfg.routing.balancers.find((b: any) => b.tag === "tier1").selector = ["pl"];
  cfg.observatory.subjectSelector = ["pl", "pl-cascade"];
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("вырождаются")));
});

test("projectVariants отдаёт массив с remark на профиль", () => {
  const input = fixture();
  const profiles: ProfileInput[] = [
    { remark: "🔀 Авто", isAuto: true, primary: ["de-direct", "pl-direct"], fallback: ["pl-cascade"] },
    { remark: "🇩🇪 Германия", primary: ["de-direct", "pl-direct"], fallback: [] },
  ];
  const rendered = projectVariants(input, profiles);
  assert.equal(rendered.length, 2);
  assert.equal(rendered[0].remark, "🔀 Авто");
  assert.ok(rendered.every((r) => validateConfig(r.config).ok));
});

test("профиль с одним каналом идёт БЕЗ балансера — как боевые «Россия» и «Белые списки»", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, { remark: "🇷🇺 Россия", primary: ["de-direct"], fallback: [] }) as any;

  assert.equal(cfg.routing.balancers.length, 0, "балансер из одного кандидата не нужен");
  assert.equal(cfg.observatory, undefined, "без балансеров измерять нечего");
  const catchAll = cfg.routing.rules.at(-1);
  assert.equal(catchAll.outboundTag, "de-direct", "catch-all должен идти прямо в outbound");
  assert.equal(catchAll.balancerTag, undefined);
  assert.equal(validateConfig(cfg).ok, true);
});

test("профиль «Россия»: ruSplit=false + один канал (РФ-трафик идёт В туннель)", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, {
    remark: "🇷🇺 Россия",
    primary: ["de-direct"],
    fallback: [],
    ruSplit: false,
  }) as any;

  assert.equal(cfg.routing.rules.filter((r: any) => r.domain).length, 0, "РФ-доменов быть не должно");
  assert.equal(cfg.routing.balancers.length, 0);
  assert.equal(validateConfig(cfg).ok, true);
});

test("два канала без резерва — балансер остаётся (выбирать есть из чего)", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, { remark: "две ноды", primary: ["de-direct", "pl-direct"], fallback: [] }) as any;
  assert.equal(cfg.routing.balancers.length, 1);
  assert.ok(cfg.observatory, "с балансером observatory обязательна");
  assert.equal(validateConfig(cfg).ok, true);
});

test("резервный тир каскадов идёт с random — как в боевой конфигурации", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, { remark: "PL", primary: ["pl-direct"], fallback: ["pl-cascade"] }) as any;
  const [tier1, tier2] = cfg.routing.balancers;
  assert.equal(tier1.strategy.type, "leastPing", "первичный тир обязан мерить задержку");
  assert.equal(tier2.strategy.type, "random");
  assert.equal(validateConfig(cfg).ok, true);
});
