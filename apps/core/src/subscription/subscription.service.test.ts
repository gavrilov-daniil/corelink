/**
 * Выдача подписки — самый горячий публичный путь.
 *
 * Главный инвариант: 200 с заглушкой допустим ТОЛЬКО для штатных пользовательских
 * состояний. На нашей поломке уходит 503, иначе Happ примет заглушку за новую
 * подписку и на плановом обновлении сотрёт рабочие каналы у всей базы.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { cleanupOrg, closeDb, createSubscriber, createSubscription, openDb, seedNetwork } from "../testing/fixtures.test.js";
import type { BotClient } from "../bot/bot.client.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { SubscriptionRepository } from "./subscription.repository.js";
import { SubscriptionService, type DeliveryRequest, type DeliveryResult } from "./subscription.service.js";

let db: Database;
let limiter: RateLimitService;
let service: SubscriptionService;
const alerts: string[] = [];

const fakeBot = {
  alert: async (text: string) => {
    alerts.push(text);
    return { ok: true, messageId: null };
  },
} as unknown as BotClient;

before(() => {
  db = openDb();
  limiter = new RateLimitService();
  service = new SubscriptionService(new SubscriptionRepository(db), fakeBot, limiter);
});

beforeEach(async () => {
  alerts.length = 0;
  await cleanupOrg(db);
});

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
  limiter.onModuleDestroy();
});

/** Свой IP на запрос: лимит по IP не должен склеивать независимые тесты. */
function happ(patch: Partial<DeliveryRequest> = {}): DeliveryRequest {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return { ip: `10.${octet()}.${octet()}.${octet()}`, userAgent: "Happ/1.9.0", ...patch };
}

function parseConfigs(res: DeliveryResult): Array<Record<string, unknown>> {
  return JSON.parse(res.body) as Array<Record<string, unknown>>;
}

function remarks(res: DeliveryResult): string[] {
  return parseConfigs(res).map((c) => String(c.remarks));
}

const DAY_MS = 86_400_000;

async function activeSubscription(patch: Partial<typeof schema.subscription.$inferInsert> = {}) {
  const subscriber = await createSubscriber(db);
  return createSubscription(db, subscriber.id, { expireAt: new Date(Date.now() + 10 * DAY_MS), ...patch });
}

/** Боевая форма сети: два direct-канала и каскадный резерв. */
function standardNetwork() {
  return seedNetwork(db, {
    channels: [
      { key: "de", kind: "direct", tag: "de-direct", cc: "DE" },
      { key: "pl", kind: "direct", tag: "pl-direct", cc: "PL" },
      { key: "plc", kind: "cascade", tag: "pl-cascade", cc: "PL", cascadeStatus: "active" },
    ],
    profiles: [
      { remark: "🔀 Авто", isAuto: true, primary: ["de", "pl"], fallback: ["plc"] },
      { remark: "🇵🇱 Польша", primary: ["pl"], fallback: ["plc"] },
    ],
  });
}

describe("Выдача подписки: штатные состояния отдают заглушку 200", () => {
  it("не-Happ UA получает заглушку, а не конфиг", async () => {
    await standardNetwork();
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ({ userAgent: "Mozilla/5.0" }));

    assert.equal(res.status, 200);
    assert.equal(res.kind, "stub");
    assert.deepEqual(remarks(res), ["Откройте подписку в приложении Happ."]);
    assert.ok(!res.body.includes("de-direct"), "тело подписки не должно утекать мимо Happ");
  });

  it("подписки нет — заглушка, а не 404 и не 500", async () => {
    await standardNetwork();

    const res = await service.deliverByShortUuid(`su-${randomUUID().replace(/-/g, "")}`, happ());

    assert.equal(res.status, 200);
    assert.equal(res.kind, "stub");
    assert.deepEqual(remarks(res), ["Подписка не найдена."]);
  });

  for (const status of ["disabled", "suspended"] as const) {
    it(`подписка в статусе ${status} получает заглушку «приостановлена»`, async () => {
      await standardNetwork();
      const sub = await activeSubscription({ status });

      const res = await service.deliverByShortUuid(sub.shortUuid, happ());

      assert.equal(res.status, 200);
      assert.equal(res.kind, "stub");
      assert.deepEqual(remarks(res), ["Подписка приостановлена."]);
    });
  }

  it("истёкшая подписка получает заглушку, а не инвентарь сети", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ status: "expired", expireAt: new Date(Date.now() - DAY_MS) });

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(res.status, 200);
    assert.equal(res.kind, "stub");
    assert.match(remarks(res)[0], /истекла/i);
    assert.ok(!res.body.includes("de-direct"), "адреса и ключи каналов не имеют права уехать истёкшему");
    assert.ok(!res.body.includes("PBK_"), "pbk каналов — карта сети для DPI");
  });

  it("подписка, которая ни разу не оплачивалась (inactive при создании), не видит каналов", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ status: "inactive" });

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(res.status, 200);
    assert.equal(res.kind, "stub");
    assert.match(remarks(res)[0], /не активна/i);
    assert.ok(!res.body.includes("203.0.113."), "инвентарь сети не должен утекать любому, кто нажал /start");
  });

  it("срок вышел, а джоба ещё не прошлась — конфига всё равно нет", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ status: "active", expireAt: new Date(Date.now() - 60_000) });

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(res.kind, "stub", "гейт по сроку не может зависеть от того, успела ли отработать subscription-expire");
    assert.match(remarks(res)[0], /истекла/i);
  });

  it("бессрочная подписка (expire_at пуст) работает: это ручная и служебная выдача", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ status: "active", expireAt: null });

    assert.equal((await service.deliverByShortUuid(sub.shortUuid, happ())).kind, "happ");
  });

  it("trial получает конфиг наравне с active", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ status: "trial" });

    assert.equal((await service.deliverByShortUuid(sub.shortUuid, happ())).kind, "happ");
  });

  it("заглушка не является рабочим профилем: подключение по ней никуда не ведёт", async () => {
    await standardNetwork();

    const res = await service.deliverByShortUuid(`su-${randomUUID().replace(/-/g, "")}`, happ());
    const [stub] = parseConfigs(res);
    const outbounds = stub.outbounds as Array<Record<string, unknown>>;
    const rules = (stub.routing as { rules: Array<Record<string, unknown>> }).rules;

    assert.deepEqual(
      outbounds.map((o) => o.protocol),
      ["blackhole"],
      "freedom-outbound давал бы «Connected» и весь трафик НАПРЯМУЮ мимо VPN",
    );
    assert.ok(
      rules.some((r) => r.outboundTag === "block" && !r.domain && !r.ip),
      "нужен catch-all в blackhole, иначе Xray выпустит трафик дефолтным маршрутом",
    );
    assert.ok(!res.body.includes('"freedom"'), "freedom в заглушке недопустим ни в каком виде");
  });
});

describe("Выдача подписки: рабочий конфиг", () => {
  it("активная подписка из Happ получает полные конфиги по профилям и заголовки клиента", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ trafficLimitBytes: 100, usedTrafficBytes: 7 });

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());
    const configs = parseConfigs(res);

    assert.equal(res.status, 200);
    assert.equal(res.kind, "happ");
    assert.deepEqual(
      configs.map((c) => c.remarks),
      ["🔀 Авто", "🇵🇱 Польша"],
      "порядок профилей задаётся sort_order и виден клиенту",
    );
    for (const cfg of configs) {
      assert.ok(Array.isArray(cfg.outbounds) && (cfg.outbounds as unknown[]).length > 0);
      assert.ok(cfg.routing, "это должен быть полный конфиг, а не заглушка");
    }

    const expire = Math.floor(new Date(sub.expireAt!).getTime() / 1000);
    assert.equal(res.headers["subscription-userinfo"], `upload=0; download=7; total=100; expire=${expire}`);
    assert.equal(res.headers["profile-update-interval"], "12");
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  });

  it("выдача отмечает посещение: оператор видит, что клиент приходил", async () => {
    await standardNetwork();
    const sub = await activeSubscription();

    await service.deliverByShortUuid(sub.shortUuid, happ({ userAgent: "Happ/1.9.0 (ios)" }));

    const [row] = await db.select().from(schema.subscription).where(eq(schema.subscription.id, sub.id));
    assert.equal(row.subLastUserAgent, "Happ/1.9.0 (ios)");
    assert.ok(row.subLastOpenedAt);
  });

  it("легаси-путь /api/sub/<shortUuid> резолвится: у мигрируемых в ссылке именно он", async () => {
    await standardNetwork();
    const sub = await activeSubscription();

    const byShortUuid = await service.deliverById(sub.shortUuid, happ());
    const byPk = await service.deliverById(sub.id, happ());

    assert.equal(byShortUuid.kind, "happ", "shortUuid обязан искаться раньше внутреннего PK");
    assert.equal(byPk.kind, "happ");
    assert.deepEqual(remarks(byShortUuid), remarks(byPk));
  });

  it("мусор в легаси-пути даёт заглушку, а не ошибку типа из Postgres", async () => {
    await standardNetwork();

    const res = await service.deliverById("../etc/passwd", happ());

    assert.equal(res.status, 200);
    assert.equal(res.kind, "stub");
    assert.deepEqual(remarks(res), ["Подписка не найдена."]);
  });
});

describe("Выдача подписки: наша поломка = 503, а не заглушка", () => {
  it("каналы и профили не собрались — 503 с retry-after", async () => {
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(res.status, 503, "200 с заглушкой заставил бы Happ стереть рабочий конфиг у всей базы");
    assert.equal(res.kind, "error");
    assert.deepEqual(JSON.parse(res.body), { error: "subscription_build_failed" });
    assert.equal(res.headers["retry-after"], "300");
    assert.equal(alerts.length, 1, "молчаливая поломка выдачи недопустима — операторов обязаны позвать");
  });

  it("конфиг не прошёл инвариант-валидатор — 503, сломанный конфиг наружу не уходит", async () => {
    // тег "f" префиксно цепляет outbound "freedom": рунет уехал бы в туннель
    await seedNetwork(db, {
      channels: [
        { key: "bad", kind: "direct", tag: "f", cc: "DE" },
        { key: "ok", kind: "direct", tag: "pl-direct", cc: "PL" },
      ],
      profiles: [{ remark: "🔀 Авто", isAuto: true, primary: ["bad", "ok"] }],
    });
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(res.status, 503);
    assert.equal(res.kind, "error");
  });

  it("исключение генератора (каскад без front) — 503, а не 500 и не заглушка", async () => {
    await seedNetwork(db, {
      withFront: false,
      channels: [
        { key: "pl", kind: "direct", tag: "pl-direct", cc: "PL" },
        { key: "plc", kind: "cascade", tag: "pl-cascade", cc: "PL", cascadeStatus: "active" },
      ],
      profiles: [{ remark: "🇵🇱 Польша", primary: ["pl"], fallback: ["plc"] }],
    });
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(res.status, 503);
    assert.equal(res.kind, "error");
  });
});

describe("Выдача подписки: что попадает в конфиг", () => {
  const cascadeNetwork = (cascadeStatus: "planned" | "active") =>
    seedNetwork(db, {
      channels: [
        { key: "pl", kind: "direct", tag: "pl-direct", cc: "PL" },
        { key: "plc", kind: "cascade", tag: "pl-cascade", cc: "PL", cascadeStatus },
      ],
      profiles: [{ remark: "🇵🇱 Польша", primary: ["pl"], fallback: ["plc"] }],
    });

  it("неактивный каскад не попадает в выдачу: полусобранная цепочка — чёрная дыра", async () => {
    await cascadeNetwork("planned");
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());
    const [config] = parseConfigs(res);

    assert.equal(res.kind, "happ");
    assert.ok(!res.body.includes("pl-cascade"), "канал недоделанного каскада не имеет права попасть клиенту");
    assert.deepEqual((config.routing as { balancers: unknown[] }).balancers, [], "остался один канал — балансер не нужен");
  });

  it("активный каскад попадает и даёт второй тир failover", async () => {
    await cascadeNetwork("active");
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());
    const [config] = parseConfigs(res);
    const balancers = (config.routing as { balancers: Array<Record<string, unknown>> }).balancers;

    assert.ok(res.body.includes("pl-cascade"));
    assert.equal(balancers.length, 2, "direct → cascade: два тира");
    assert.equal(balancers[0].fallbackTag, "lo-out-1");
  });

  it("три эшелона из профиля доходят до клиента: tier1 → tier2 → tier3", async () => {
    await seedNetwork(db, {
      channels: [
        { key: "de", kind: "direct", tag: "de-direct", cc: "DE" },
        { key: "nl", kind: "direct", tag: "nl-direct", cc: "NL" },
        { key: "fi", kind: "direct", tag: "fi-direct", cc: "FI" },
      ],
      profiles: [{ remark: "🔀 Авто", isAuto: true, primary: ["de"], fallback: ["nl"], reserve: ["fi"] }],
    });
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());
    const [config] = parseConfigs(res);
    const balancers = (config.routing as { balancers: Array<Record<string, unknown>> }).balancers;

    assert.deepEqual(
      balancers.map((b) => b.tag),
      ["tier1", "tier2", "tier3"],
    );
    assert.equal(balancers[1].fallbackTag, "lo-out-2", "tier2 при отказе уходит в tier3");
    assert.equal(balancers[2].fallbackTag, undefined);
  });

  it("профиль, оставшийся без каналов, выбрасывается целиком", async () => {
    await seedNetwork(db, {
      channels: [
        { key: "pl", kind: "direct", tag: "pl-direct", cc: "PL" },
        { key: "plc", kind: "cascade", tag: "pl-cascade", cc: "PL", cascadeStatus: "planned" },
      ],
      profiles: [
        { remark: "🇵🇱 Польша", primary: ["pl"], fallback: ["plc"] },
        { remark: "🇩🇪 Германия", primary: ["plc"] },
      ],
    });
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(res.kind, "happ");
    assert.deepEqual(remarks(res), ["🇵🇱 Польша"], "балансер с пустым селектором = клиент без интернета и без ошибки");
  });

  it("выключенный хост убирает свой канал из выдачи", async () => {
    await seedNetwork(db, {
      channels: [
        { key: "de", kind: "direct", tag: "de-direct", cc: "DE", hostDisabled: true },
        { key: "pl", kind: "direct", tag: "pl-direct", cc: "PL" },
      ],
      profiles: [{ remark: "🔀 Авто", isAuto: true, primary: ["de", "pl"] }],
    });
    const sub = await activeSubscription();

    const res = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(res.kind, "happ");
    assert.ok(!res.body.includes("de-direct"));
    assert.ok(res.body.includes("pl-direct"));
  });
});

describe("Выдача подписки: HWID-лимит", () => {
  it("устройство сверх лимита получает заглушку про лимит, а не конфиг", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ hwidDeviceLimit: 1 });

    const first = await service.deliverByShortUuid(sub.shortUuid, happ({ hwid: "aaa-device" }));
    const second = await service.deliverByShortUuid(sub.shortUuid, happ({ hwid: "bbb-device" }));

    assert.equal(first.kind, "happ", "занявшее слот устройство продолжает работать");
    assert.equal(second.status, 200);
    assert.equal(second.kind, "stub");
    assert.match(remarks(second)[0], /лимит устройств: 1/i);
  });

  it("клиент без x-hwid получает конфиг даже при включённом лимите", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ hwidDeviceLimit: 1 });

    await service.deliverByShortUuid(sub.shortUuid, happ({ hwid: "aaa-device" }));
    const anonymous = await service.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(anonymous.kind, "happ", "часть клиентов заголовок не шлёт — отказ ломал бы живых пользователей");
    const devices = await db
      .select()
      .from(schema.subscriberDevice)
      .where(eq(schema.subscriberDevice.subscriptionId, sub.id));
    assert.equal(devices.length, 1, "неизвестное устройство слот не занимает");
  });

  it("повторный приход того же устройства не плодит строк и слот не теряет", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ hwidDeviceLimit: 1 });

    for (let i = 0; i < 3; i += 1) {
      const res = await service.deliverByShortUuid(sub.shortUuid, happ({ hwid: "aaa-device", deviceOs: "ios" }));
      assert.equal(res.kind, "happ", `запрос ${i + 1} того же устройства обязан пройти`);
    }

    const devices = await db
      .select()
      .from(schema.subscriberDevice)
      .where(eq(schema.subscriberDevice.subscriptionId, sub.id));
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceOs, "ios");
  });

  it("лимит выключен (null в схеме) — устройства не ограничиваются", async () => {
    await standardNetwork();
    const sub = await activeSubscription({ hwidDeviceLimit: null });

    for (const hwid of ["d1", "d2", "d3", "d4"]) {
      assert.equal((await service.deliverByShortUuid(sub.shortUuid, happ({ hwid }))).kind, "happ");
    }
  });
});

describe("Выдача подписки: rate-limit", () => {
  it("перебор по одной ссылке упирается в 429 и тела подписки не отдаёт", async () => {
    await standardNetwork();
    const sub = await activeSubscription();

    // отдельный инстанс с жёстким лимитом: конфиг читается в конструкторе сервиса
    const previous = process.env.SUB_RATE_LIMIT_PER_SUB;
    process.env.SUB_RATE_LIMIT_PER_SUB = "2";
    const strict = new SubscriptionService(new SubscriptionRepository(db), fakeBot, new RateLimitService());
    if (previous === undefined) delete process.env.SUB_RATE_LIMIT_PER_SUB;
    else process.env.SUB_RATE_LIMIT_PER_SUB = previous;

    assert.equal((await strict.deliverByShortUuid(sub.shortUuid, happ())).kind, "happ");
    assert.equal((await strict.deliverByShortUuid(sub.shortUuid, happ())).kind, "happ");
    const denied = await strict.deliverByShortUuid(sub.shortUuid, happ());

    assert.equal(denied.status, 429, "на не-2xx Happ держит прошлый рабочий конфиг");
    assert.deepEqual(JSON.parse(denied.body), { error: "rate_limited" });
    assert.ok(Number(denied.headers["retry-after"]) > 0);
    assert.ok(!denied.body.includes("pl-direct"));
  });
});
