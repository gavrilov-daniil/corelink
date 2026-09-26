/**
 * Ручная выдача из админки — без оплаты и без бота.
 *
 * Инварианты: подписчику из бота доступ ложится на его основную подписку (вторую бот
 * не показал бы); срок считается от текущего окончания; блокировку выдача и продление
 * не снимают; выданный доступ сразу доезжает до нод; повтор запроса ничего не двоит.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
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

/** Целых дней от сейчас до даты: доли дня уходят на время самого теста. */
function daysFromNow(date: Date | null): number {
  return Math.round(((date?.getTime() ?? 0) - Date.now()) / DAY_MS);
}

describe("ручная выдача: новый человек без бота", () => {
  it("заводит подписчика без Telegram с меткой и активную подписку на срок", async () => {
    const res = await service.grantManual({ label: "Тестер Вася", days: 30, deviceLimit: 3, trafficGb: 50 });

    assert.match(res.subscriptionUrl, /\/auto\/[0-9a-f]{24}$/);
    const sub = await subscriptionRow(res.subscriptionId);
    assert.equal(sub.status, "active");
    assert.equal(daysFromNow(sub.expireAt), 30);
    assert.equal(sub.hwidDeviceLimit, 3);
    assert.equal(sub.trafficLimitBytes, 50 * 1024 ** 3);

    const [person] = await db.select().from(schema.subscriber).where(eq(schema.subscriber.id, res.subscriberId));
    assert.equal(person.telegramId, null);
    assert.equal(person.description, "Тестер Вася");
  });

  it("бессрочно и без лимитов: срока нет, лимиты пустые", async () => {
    const res = await service.grantManual({ label: "Служебный", days: null });
    const sub = await subscriptionRow(res.subscriptionId);

    assert.equal(sub.expireAt, null);
    assert.equal(sub.hwidDeviceLimit, null);
    assert.equal(sub.trafficLimitBytes, null);
  });

  it("свои squad'ы ложатся явным членством; несуществующий — 400, и человек не заводится", async () => {
    const premium = await createSquad(db, "Премиум");
    const res = await service.grantManual({ label: "VIP", days: 30, squadIds: [premium.id] });
    const links = await db
      .select()
      .from(schema.subscriptionSquad)
      .where(eq(schema.subscriptionSquad.subscriptionId, res.subscriptionId));
    assert.deepEqual(
      links.map((l) => l.squadId),
      [premium.id],
    );

    await assert.rejects(
      () => service.grantManual({ label: "Лишний", days: 30, squadIds: ["11111111-1111-1111-1111-111111111111"] }),
      (e) => status(e) === 400,
    );
    const ghosts = await db
      .select()
      .from(schema.subscriber)
      .where(and(eq(schema.subscriber.orgId, TEST_ORG_ID), eq(schema.subscriber.description, "Лишний")));
    assert.equal(ghosts.length, 0);
  });

  it("без метки, без срока и с нулевым сроком — 400", async () => {
    await assert.rejects(() => service.grantManual({ days: 30 }), (e) => status(e) === 400);
    await assert.rejects(() => service.grantManual({ label: "Кто-то" }), (e) => status(e) === 400);
    await assert.rejects(() => service.grantManual({ label: "Кто-то", days: 0 }), (e) => status(e) === 400);
  });
});

describe("ручная выдача: подписчику из бота", () => {
  it("ложится на основную подписку: вторая не заводится, ссылка та же, что в боте", async () => {
    const person = await createSubscriber(db);
    const primary = await service.ensureSubscription(person.id); // inactive — как после /start

    const res = await service.grantManual({ subscriberId: person.id, days: 14 });

    assert.equal(res.subscriptionId, primary.id);
    assert.ok(res.subscriptionUrl.endsWith(`/auto/${primary.shortUuid}`));
    const all = await db.select().from(schema.subscription).where(eq(schema.subscription.subscriberId, person.id));
    assert.equal(all.length, 1);
    const sub = await subscriptionRow(primary.id);
    assert.equal(sub.status, "active");
    assert.equal(daysFromNow(sub.expireAt), 14);
  });

  it("срок прибавляется к текущему окончанию, а лимит без поля не трогается", async () => {
    const person = await createSubscriber(db);
    const sub = await createSubscription(db, person.id, {
      expireAt: new Date(Date.now() + 10 * DAY_MS),
      hwidDeviceLimit: 2,
    });

    await service.grantManual({ subscriberId: person.id, days: 30 });

    const granted = await subscriptionRow(sub.id);
    assert.equal(daysFromNow(granted.expireAt), 40);
    assert.equal(granted.hwidDeviceLimit, 2);
  });

  it("бессрочной дни не прибавить — 400; неизвестный подписчик — 404", async () => {
    const person = await createSubscriber(db);
    await createSubscription(db, person.id); // active без срока — бессрочная

    await assert.rejects(() => service.grantManual({ subscriberId: person.id, days: 30 }), (e) => status(e) === 400);
    await assert.rejects(
      () => service.grantManual({ subscriberId: "11111111-1111-1111-1111-111111111111", days: 30 }),
      (e) => status(e) === 404,
    );
  });
});

describe("продление и отключение", () => {
  it("истёкшая продлевается от сегодня и снова active", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, {
      status: "expired",
      expireAt: new Date(Date.now() - 5 * DAY_MS),
    });

    const res = await service.extend(sub.id, 30);

    assert.equal(res.status, "active");
    assert.equal(daysFromNow(res.expireAt), 30);
  });

  it("продление не снимает блокировку: отключённая остаётся disabled", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, {
      status: "disabled",
      expireAt: new Date(Date.now() + 5 * DAY_MS),
    });

    const res = await service.extend(sub.id, 10);

    assert.equal(res.status, "disabled");
    assert.equal(daysFromNow(res.expireAt), 15);
  });

  it("продление бессрочной и продление без срока — 400", async () => {
    const forever = await createSubscription(db, (await createSubscriber(db)).id);
    await assert.rejects(() => service.extend(forever.id, 30), (e) => status(e) === 400);
    await assert.rejects(() => service.extend(forever.id, undefined), (e) => status(e) === 400);
  });

  it("отключить → disabled, включить → active; повтор ничего не меняет", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, {
      expireAt: new Date(Date.now() + 5 * DAY_MS),
    });

    assert.deepEqual(await service.setEnabled(sub.id, false), { subscriptionId: sub.id, status: "disabled", changed: true });
    assert.equal((await service.setEnabled(sub.id, false)).changed, false);
    assert.equal((await service.setEnabled(sub.id, true)).status, "active");
  });

  it("включение истёкшей по сроку даёт expired, а не active", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, {
      status: "disabled",
      expireAt: new Date(Date.now() - DAY_MS),
    });
    assert.equal((await service.setEnabled(sub.id, true)).status, "expired");
  });

  it("включение снимает приостановку за abuse (suspended)", async () => {
    const sub = await createSubscription(db, (await createSubscriber(db)).id, {
      status: "suspended",
      expireAt: new Date(Date.now() + 5 * DAY_MS),
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

    const res = await service.grantManual({ label: "Друг", days: 7 });
    const sub = await subscriptionRow(res.subscriptionId);
    const users = (await state.getDesiredState(loc.node.id)).users;
    assert.ok(users.some((u) => u.uuid === sub.vlessUuid), "без ожидания пересборки по расписанию");

    await service.setEnabled(res.subscriptionId, false);
    const after = (await state.getDesiredState(loc.node.id)).users;
    assert.equal(after.some((u) => u.uuid === sub.vlessUuid), false);
  });
});

describe("повтор запроса (x-client-request-id)", () => {
  it("дабл-клик создания не заводит второго человека", async () => {
    const controller = new SubscribersController(service, new IdempotencyService());
    const requestId = randomUUID();

    const first = await controller.grantManual({ label: "Дубль", days: 30 }, requestId);
    const second = await controller.grantManual({ label: "Дубль", days: 30 }, requestId);

    assert.equal(second.subscriptionId, first.subscriptionId);
    const people = await db
      .select()
      .from(schema.subscriber)
      .where(and(eq(schema.subscriber.orgId, TEST_ORG_ID), eq(schema.subscriber.description, "Дубль")));
    assert.equal(people.length, 1);
  });

  it("повтор продления с тем же ключом не добавляет дни второй раз", async () => {
    const controller = new SubscribersController(service, new IdempotencyService());
    const sub = await createSubscription(db, (await createSubscriber(db)).id, {
      expireAt: new Date(Date.now() + DAY_MS),
    });
    const requestId = randomUUID();

    await controller.extend(sub.id, { days: 30 }, requestId);
    await controller.extend(sub.id, { days: 30 }, requestId);

    assert.equal(daysFromNow((await subscriptionRow(sub.id)).expireAt), 31);
  });
});
