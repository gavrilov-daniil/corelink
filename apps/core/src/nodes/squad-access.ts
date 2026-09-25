import { ConflictException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Доступ к локации: какие squad'ы открывают её входы (inbound'ы) клиентам.
 *
 * Общий squad (for_all) — в нём состоит каждая подписка org без строк
 * subscription_squad, поэтому доступ к его локациям есть у всех: новых, импортированных,
 * триальных — без синхронизации и без привязки к тарифу. Мастер кладёт в него новую
 * локацию по умолчанию; исключение = нет строки squad_inbound, отдельного флага нет.
 */

/** Имя общего squad'а при заведении. Дальше его можно переименовать: ищется он по флагу. */
export const GENERAL_SQUAD_NAME = "Общий";

/** Общий squad org. Заводится при первой надобности; второй не даёт squad_org_for_all_uq. */
export async function ensureGeneralSquad(tx: Tx, org: string): Promise<{ id: string; name: string }> {
  await tx
    .insert(schema.squad)
    .values({ orgId: org, name: GENERAL_SQUAD_NAME, forAll: true })
    // без target: гасит и второй общий squad, и обычный squad с тем же именем —
    // второй случай разбираем ниже понятной ошибкой вместо 500 на 23505
    .onConflictDoNothing();
  const general = await findGeneralSquad(tx, org);
  if (!general) {
    throw new ConflictException(
      `squad «${GENERAL_SQUAD_NAME}» уже есть, но он не общий — переименуйте его, чтобы завести общий`,
    );
  }
  return general;
}

export async function findGeneralSquad(tx: Tx | Database, org: string): Promise<{ id: string; name: string } | null> {
  const [row] = await tx
    .select({ id: schema.squad.id, name: schema.squad.name })
    .from(schema.squad)
    .where(and(eq(schema.squad.orgId, org), eq(schema.squad.forAll, true)))
    .limit(1);
  return row ?? null;
}

/** Входы ноды. «1 config-профиль = 1 нода», поэтому это inbound'ы её профиля. */
export async function nodeInboundIds(tx: Tx | Database, nodeId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: schema.inbound.id })
    .from(schema.inbound)
    .innerJoin(schema.node, eq(schema.node.configProfileId, schema.inbound.configProfileId))
    .where(eq(schema.node.id, nodeId));
  return rows.map((r) => r.id);
}

export interface LocationAccessInput {
  org: string;
  inboundIds: string[];
  /** Входит ли локация в общий squad. undefined — не трогаем. */
  general?: boolean;
  /** Полный набор обычных squad'ов локации (существование проверяет вызывающий). undefined — не трогаем. */
  squadIds?: string[];
}

/**
 * Приводит доступ к локации к заданному состоянию. Идемпотентно: повтор с теми же
 * входами ничего не меняет. Сами squad'ы не удаляются — в них могут быть другие локации.
 * Пересборка нод — забота вызывающего, после коммита.
 */
export async function applyLocationAccess(tx: Tx, a: LocationAccessInput): Promise<void> {
  if (a.inboundIds.length === 0) return;

  if (a.general === true) {
    const general = await ensureGeneralSquad(tx, a.org);
    await link(tx, general.id, a.inboundIds);
  } else if (a.general === false) {
    const general = await findGeneralSquad(tx, a.org);
    if (general) await unlink(tx, general.id, a.inboundIds);
  }

  if (a.squadIds !== undefined) {
    const custom = await tx
      .select({ id: schema.squad.id })
      .from(schema.squad)
      .where(and(eq(schema.squad.orgId, a.org), eq(schema.squad.forAll, false)));
    for (const s of custom) {
      if (a.squadIds.includes(s.id)) await link(tx, s.id, a.inboundIds);
      else await unlink(tx, s.id, a.inboundIds);
    }
  }
}

async function link(tx: Tx, squadId: string, inboundIds: string[]): Promise<void> {
  await tx
    .insert(schema.squadInbound)
    .values(inboundIds.map((inboundId) => ({ squadId, inboundId })))
    .onConflictDoNothing({ target: [schema.squadInbound.squadId, schema.squadInbound.inboundId] });
}

async function unlink(tx: Tx, squadId: string, inboundIds: string[]): Promise<void> {
  await tx
    .delete(schema.squadInbound)
    .where(and(eq(schema.squadInbound.squadId, squadId), inArray(schema.squadInbound.inboundId, inboundIds)));
}
