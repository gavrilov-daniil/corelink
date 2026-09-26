/**
 * Ручная выдача из админки — без оплаты и без бота.
 *
 * Инварианты: подписчику из бота доступ ложится на его основную подписку (вторую бот
 * не показал бы); срок — ровно тот момент, что выбран в календаре; срок, сдвинутый
 * оплатой, пока форма была открыта, не затирается; блокировку новый срок не снимает;
 * выданный доступ сразу доезжает до нод; повтор запроса ничего не двоит.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import {
  TEST_ORG_ID,
  cleanupOrg,
  closeDb,
  createSquad,
  createSubscriber,
  createSubscription,
  openDb,
} from "../testing/fixtures.test.js";
import { IdempotencyService } from "../common/idempotency.service.js";
import type { AttributionService } from "../crm/attribution.service.js";
import { InfraService } from "../nodes/infra.service.js";
import { NodeStateService } from "../nodes/node-state.service.js";
import type { LedgerService } from "../payments/ledger.service.js";
import { SubscribersController } from "./subscribers.controller.js";
import { SubscribersService } from "./subscribers.service.js";

const DAY_MS = 86_400_000;

let db: Database;
let state: NodeStateService;
let infra: InfraService;
let service: SubscribersService;

before(() => {
  db = openDb();
  state = new NodeStateService(db);
  infra = new InfraService(db, state);
  // ledger и атрибуция в ручной выдаче не участвуют: денег и рекламы здесь нет
  service = new SubscribersService(db, {} as LedgerService, {} as AttributionService, state);
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

function status(err: unknown): number {
  return (err as { status?: number }).status ?? 0;
}

async function subscriptionRow(id: string) {
  const [row] = await db.select().from(schema.subscription).where(eq(schema.subscription.id, id));
  return row;
}

/** Момент через n дней с точностью до минуты — ровно так его отдаёт календарь. */
function inDays(n: number): string {
  const d = new Date(Date.now() + n * DAY_MS);
  d.setSeconds(0, 0);
  return d.toISOString();
}

describe("ручная выдача: новый человек без бота", () => {
  it("заводит подписчика без Telegram с меткой и активную подписку до выбранного момента", async () => {
    const until = inDays(30);
    const res = await service.grantManual({ label: "Тестер Вася", expireAt: until, deviceLimit: 3, trafficGb: 50 });

    assert.match(res.subscriptionUrl, /\/auto\/[0-9a-f]{24}$/);
    const sub = await subscriptionRow(res.subscriptionId);
    assert.equal(sub.status, "active");
    assert.equal(sub.expireAt?.toISOString(), until, "срок — ровно выбранные дата и время");
    assert.equal(sub.hwidDeviceLimit, 3);
    assert.equal(sub.trafficLimitBytes, 50 * 1024 ** 3);

    const [person] = await db.select().from(schema.subscriber).where(eq(schema.subscriber.id, res.subscriberId));
    assert.equal(person.telegramId, null);
    assert.equal(person.description, "Тестер Вася");
  });

  it("бессрочно и без лимитов: срока нет, лимиты пустые", async () => {
    const res = await service.grantManual({ label: "Служебный", expireAt: null });
    const sub = await subscriptionRow(res.subscriptionId);

    assert.equal(sub.expireAt, null);
    assert.equal(sub.hwidDeviceLimit, null);
    assert.equal(sub.trafficLimitBytes, null);
  });

  it("свои squad'ы ложатся явным членством; несуществующий — 400, и человек не заводится", async () => {
    const premium = await createSquad(db, "Премиум");
    const res = await service.grantManual({ label: "VIP", expireAt: inDays(30), squadIds: [premium.id] });
    const links = await db
      .select()
      .from(schema.subscriptionSquad)
      .where(eq(schema.subscriptionSquad.subscriptionId, res.subscriptionId));
    assert.deepEqual(
      links.map((l) => l.squadId),
      [premium.id],
    );

    await assert.rejects(
      () =>
        service.grantManual({
          label: "Лишний",
          expireAt: inDays(30),
          squadIds: ["11111111-1111-1111-1111-111111111111"],
        }),
      (e) => status(e) === 400,
    );
    const ghosts = await db
      .select()
      .from(schema.subscriber)
      .where(and(eq(schema.subscriber.orgId, TEST_ORG_ID), eq(schema.subscriber.description, "Лишний")));
    assert.equal(ghosts.length, 0);
  });

  it("без метки, без срока, с прошедшей датой, дальше 10 лет и с мусором вместо даты — 400", async () => {
    await assert.rejects(() => service.grantManual({ expireAt: inDays(30) }), (e) => status(e) === 400);
    await assert.rejects(() => service.grantManual({ label: "Кто-то" }), (e) => status(e) === 400);
    await assert.rejects(() => service.grantManual({ label: "Кто-то", expireAt: inDays(-1) }), (e) => status(e) === 400);
    await assert.rejects(() => service.grantManual({ label: "Кто-то", expireAt: inDays(3651) }), (e) => status(e) === 400);
    await assert.rejects(() => service.grantManual({ label: "Кто-то", expireAt: "завтра" }), (e) => status(e) === 400);
  });
});

describe("ручная выдача: подписчику из бота", () => {
  it("ложится на основную подписку: вторая не заводится, ссылка та же, срок — ровно выбранный", async () => {
    const person = await createSubscriber(db);
    const primary = await service.ensureSubscription(person.id); // inactive — как после /start
    const until = inDays(14);

    const res = await service.grantManual({ subscriberId: person.id, expireAt: until, expectedExpireAt: null });

    assert.equal(res.subscriptionId, primary.id);
    assert.ok(res.subscriptionUrl.endsWith(`/auto/${primary.shortUuid}`));
    const all = await db.select().from(schema.subscription).where(eq(schema.subscription.subscriberId, person.id));
    assert.equal(all.length, 1);
    const sub = await subscriptionRow(primary.id);
    assert.equal(sub.status, "active");
    assert.equal(sub.expireAt?.toISOString(), until);
  });

  it("срок, сдвинутый оплатой, пока форма была открыта, — 409, а не затирание оплаченных дней", async () => {
    const person = await createSubscriber(db);
    const paidUntil = new Date(inDays(40)); // оплата продлила, пока оператор смотрел на старый срок
    const sub = await createSubscription(db, person.id, { expireAt: paidUntil });

    await assert.rejects(
      () => service.grantManual({ subscriberId: person.id, expireAt: inDays(20), expectedExpireAt: inDays(10) }),
      (e) => status(e) === 409,
    );
    assert.equal((await subscriptionRow(sub.id)).expireAt?.toISOString(), paidUntil.toISOString());
  });

  it("лимит без поля не трогается; повтор того же запроса — не конфликт", async () => {
    const person = await createSubscriber(db);
    const seen = inDays(10);
    const sub = await createSubscription(db, person.id, { expireAt: new Date(seen), hwidDeviceLimit: 2 });
    const body = { subscriberId: person.id, expireAt: inDays(40), expectedExpireAt: seen };

    await service.grantManual(body);
    await service.grantManual(body);

    const granted = await subscriptionRow(sub.id);
    assert.equal(granted.expireAt?.toISOString(), body.expireAt);
    assert.equal(granted.hwidDeviceLimit, 2);
  });

  it("неизвестный подписчик — 404", async () => {
    await assert.rejects(
      () => service.grantManual({ subscriberId: "11111111-1111-1111-1111-111111111111", expireAt: inDays(30) }),
      (e) => status(e) === 404,
    );
  });
});

describe("срок из карточки и отключение", () => {
  it("истёкшая с новым сроком снова active", async () => {
    const expiredAt = new Date(inDays(-5));
    const sub = await createSubscription(db, (await createSubscriber(db)).id, { status: "expired", expireAt: expiredAt });
    const until = inDays(30);

    const res = await service.setExpiry(sub.id, { expireAt: until, expectedExpireAt: expiredAt.toISOString() });

    assert.equal(res.status, "active");
    assert.equal(res.expireAt?.toISOString(), until);
  });

  it("новый срок не снимает блокировку: отключённая остаётся disabled", async () => {
    const seen = new Date(inDays(5));
    const sub = await createSubscription(db, (await createSubscriber(db)).id, { status: "disabled", expireAt: seen });

    const res = await service.setExpiry(sub.id, { expireAt: inDays(15), expectedExpireAt: seen.toISOString() });

    assert.equal(res.status, "disabled");
  });

  it("бессрочную можно ограничить датой и вернуть в бессрочную", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id); // active без срока
    const until = inDays(10);

    await service.setExpiry(sub.id, { expireAt: until, expectedExpireAt: null });
    assert.equal((await subscriptionRow(sub.id)).expireAt?.toISOString(), until);

    await service.setExpiry(sub.id, { expireAt: null, expectedExpireAt: until });
    assert.equal((await subscriptionRow(sub.id)).expireAt, null);
  });

  it("срок сдвинулся, пока карточка была открыта, — 409; без срока в запросе — 400", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, { expireAt: new Date(inDays(40)) });

    await assert.rejects(
      () => service.setExpiry(sub.id, { expireAt: inDays(20), expectedExpireAt: inDays(10) }),
      (e) => status(e) === 409,
    );
    await assert.rejects(() => service.setExpiry(sub.id, {}), (e) => status(e) === 400);
  });

  it("сверка срока не спотыкается о микросекунды в базе", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id);
    // срок с микросекундами — так его пишет SQL-арифметика; в JS-дате их нет
    await db.execute(sql`update subscription set expire_at = now() + interval '5 days' where id = ${sub.id}`);
    const seen = (await subscriptionRow(sub.id)).expireAt!.toISOString();

    const res = await service.setExpiry(sub.id, { expireAt: inDays(30), expectedExpireAt: seen });
    assert.equal(res.subscriptionId, sub.id);
  });

  it("отключить → disabled, включить → active; повтор ничего не меняет", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, { expireAt: new Date(inDays(5)) });

    assert.deepEqual(await service.setEnabled(sub.id, false), { subscriptionId: sub.id, status: "disabled", changed: true });
    assert.equal((await service.setEnabled(sub.id, false)).changed, false);
    assert.equal((await service.setEnabled(sub.id, true)).status, "active");
  });

  it("включение истёкшей по сроку даёт expired, а не active", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, {
      status: "disabled",
      expireAt: new Date(inDays(-1)),
    });
    assert.equal((await service.setEnabled(sub.id, true)).status, "expired");
  });

  it("включение снимает приостановку за abuse (suspended)", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, {
      status: "suspended",
      expireAt: new Date(inDays(5)),
    });
    assert.equal((await service.setEnabled(sub.id, true)).status, "active");
  });

  it("неактивированную не отключаем: включение сделало бы из неё бессрочную", async () => {
    const sub = await service.ensureSubscription((await createSubscriber(db)).id); // inactive, без срока

    assert.equal((await service.setEnabled(sub.id, false)).changed, false);
    assert.equal((await subscriptionRow(sub.id)).status, "inactive");
  });
});

describe("выданный доступ сразу на нодах", () => {
  it("ручная подписка попадает в клиенты ноды общего squad'а, отключение снимает её", async () => {
    const loc = await infra.provisionLocation({
      name: "de-manual",
      primaryIp: "203.0.113.50",
      sni: "ads.x5.ru",
      country: "DE",
    });

    const res = await service.grantManual({ label: "Друг", expireAt: inDays(7) });
    const sub = await subscriptionRow(res.subscriptionId);
    const users = (await state.getDesiredState(loc.node.id)).users;
    assert.ok(users.some((u) => u.uuid === sub.vlessUuid), "без ожидания пересборки по расписанию");

    await service.setEnabled(res.subscriptionId, false);
    const after = (await state.getDesiredState(loc.node.id)).users;
    assert.equal(after.some((u) => u.uuid === sub.vlessUuid), false);
  });
});

describe("повтор запроса", () => {
  it("дабл-клик создания (тот же x-client-request-id) не заводит второго человека", async () => {
    const controller = new SubscribersController(service, new IdempotencyService());
    const requestId = randomUUID();
    const body = { label: "Дубль", expireAt: inDays(30) };

    const first = await controller.grantManual(body, requestId);
    const second = await controller.grantManual(body, requestId);

    assert.equal(second.subscriptionId, first.subscriptionId);
    const people = await db
      .select()
      .from(schema.subscriber)
      .where(and(eq(schema.subscriber.orgId, TEST_ORG_ID), eq(schema.subscriber.description, "Дубль")));
    assert.equal(people.length, 1);
  });

  it("повтор установки того же срока — не конфликт и не сдвиг", async () => {
    const controller = new SubscribersController(service, new IdempotencyService());
    const seen = inDays(1);
    const sub = await createSubscription(db, (await createSubscriber(db)).id, { expireAt: new Date(seen) });
    const body = { expireAt: inDays(31), expectedExpireAt: seen };

    await controller.setExpiry(sub.id, body);
    await controller.setExpiry(sub.id, body);

    assert.equal((await subscriptionRow(sub.id)).expireAt?.toISOString(), body.expireAt);
  });
});
