/**
 * Тарифы из админки. Squad тарифа — это доступ к нодам после оплаты: чужой id в тарифе
 * ронял бы фулфилмент платежа по FK subscription_squad (деньги приняты, дней нет),
 * поэтому мусор отвергается на входе, а не при оплате.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Database } from "@corelink/db";
import { cleanupOrg, closeDb, createSquad, openDb } from "../testing/fixtures.test.js";
import type { AttributionService } from "../crm/attribution.service.js";
import type { NodeStateService } from "../nodes/node-state.service.js";
import type { LedgerService } from "../payments/ledger.service.js";
import { SubscribersService } from "./subscribers.service.js";

let db: Database;
let service: SubscribersService;

before(() => {
  db = openDb();
  // тарифам нужен только db: ledger, атрибуция и ноды в createPlan/updatePlan не участвуют
  service = new SubscribersService(db, {} as LedgerService, {} as AttributionService, {} as NodeStateService);
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

function status(err: unknown): number {
  return (err as { status?: number }).status ?? 0;
}

const plan = () => ({
  code: `p-${Math.random().toString(36).slice(2, 8)}`,
  title: "Месяц",
  periodDays: 30,
  priceKopeks: 29_900,
});

describe("тарифы: squad'ы", () => {
  it("тариф со своим squad'ом сохраняется", async () => {
    const premium = await createSquad(db, "Премиум");
    const created = await service.createPlan({ ...plan(), squadIds: [premium.id] });
    assert.deepEqual(created.squadIds, [premium.id]);
  });

  it("несуществующий или кривой squad отвергается 400 — и при создании, и при правке", async () => {
    await assert.rejects(
      () => service.createPlan({ ...plan(), squadIds: ["11111111-1111-1111-1111-111111111111"] }),
      (e) => status(e) === 400,
    );
    const created = await service.createPlan(plan());
    await assert.rejects(() => service.updatePlan(created.id, { squadIds: ["не-uuid"] }), (e) => status(e) === 400);
  });
});
