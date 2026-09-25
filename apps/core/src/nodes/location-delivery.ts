import { and, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Выдача локации клиентам: канал локации + её членство в профилях подписки с тиром.
 *
 * Без этого заведённая и настроенная нода не попадала ни в одну подписку — профили и
 * каналы создавались только руками. Мастер кладёт локацию в «🔀 Авто» и профиль её
 * страны; исключение из профиля = отсутствие строки profile_channel, тир — поле этой
 * строки. Отдельного флага «исключён» нет: источник правды один.
 */

/** Имя профиля «Авто» — натуральный ключ (profile_org_remark_uq), как в VARIANTS панели. */
export const AUTO_PROFILE_REMARK = "🔀 Авто";

/** Эшелоны, которые понимает выдача (loadProfiles читает 1..3). */
export const LOCATION_TIERS = [1, 2, 3] as const;

/**
 * Тег канала локации. Фиксированной длины: селектор балансера матчит теги по ПРЕФИКСУ,
 * и тег одной локации, оказавшийся префиксом тега другой, слил бы их эшелоны. У тегов
 * одной длины такого не бывает. Выводится из id ноды — повтор находит тот же канал.
 */
export function locationChannelTag(nodeId: string): string {
  return `loc-${nodeId.replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Имя профиля страны: флаг + название по-русски из ICU — без ручной таблицы стран.
 * null для кода не из двух латинских букв: флаг из такого не собрать.
 */
export function countryProfileRemark(country: string | null | undefined): string | null {
  const code = (country ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const flag = String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
  const name = new Intl.DisplayNames(["ru"], { type: "region" }).of(code) ?? code;
  return `${flag} ${name}`;
}

export interface LocationDeliveryInput {
  org: string;
  nodeId: string;
  hostId: string;
  country: string | null;
  tier: number;
  inAuto: boolean;
  inCountry: boolean;
}

export interface LocationDeliveryResult {
  channelTag: string;
  tier: number;
  /** В какие профили локация входит после применения. */
  profiles: string[];
}

/**
 * Приводит выдачу локации к заданному состоянию: канал есть, в «Авто» и профиле страны
 * локация есть или нет, тир — как задан. Идемпотентно: повтор с теми же входами ничего
 * не меняет. Сами профили не удаляются — в них могут быть другие локации.
 */
export async function applyLocationDelivery(tx: Tx, d: LocationDeliveryInput): Promise<LocationDeliveryResult> {
  const tag = locationChannelTag(d.nodeId);
  await tx
    .insert(schema.channel)
    .values({ orgId: d.org, kind: "direct", tag, cc: d.country, hostId: d.hostId })
    .onConflictDoNothing({ target: [schema.channel.orgId, schema.channel.tag] });
  const [channel] = await tx
    .select({ id: schema.channel.id })
    .from(schema.channel)
    .where(and(eq(schema.channel.orgId, d.org), eq(schema.channel.tag, tag)))
    .limit(1);
  if (!channel) throw new Error(`delivery: канал ${tag} не найден после вставки`);

  const countryRemark = countryProfileRemark(d.country);
  // «Авто» — первым в списке у клиента, страны — после него
  const managed = [{ remark: AUTO_PROFILE_REMARK, isAuto: true, sortOrder: 0, wanted: d.inAuto }];
  if (countryRemark) managed.push({ remark: countryRemark, isAuto: false, sortOrder: 100, wanted: d.inCountry });

  const profiles: string[] = [];
  for (const m of managed) {
    if (m.wanted) {
      await tx
        .insert(schema.profile)
        .values({ orgId: d.org, remark: m.remark, isAuto: m.isAuto, sortOrder: m.sortOrder })
        .onConflictDoNothing({ target: [schema.profile.orgId, schema.profile.remark] });
    }
    const [profile] = await tx
      .select({ id: schema.profile.id })
      .from(schema.profile)
      .where(and(eq(schema.profile.orgId, d.org), eq(schema.profile.remark, m.remark)))
      .limit(1);
    if (!profile) continue; // исключаем из профиля, которого нет, — делать нечего

    if (m.wanted) {
      await tx
        .insert(schema.profileChannel)
        .values({ orgId: d.org, profileId: profile.id, channelId: channel.id, tier: d.tier })
        .onConflictDoUpdate({
          target: [schema.profileChannel.profileId, schema.profileChannel.channelId],
          set: { tier: d.tier },
        });
      profiles.push(m.remark);
    } else {
      await tx
        .delete(schema.profileChannel)
        .where(and(eq(schema.profileChannel.profileId, profile.id), eq(schema.profileChannel.channelId, channel.id)));
    }
  }
  return { channelTag: tag, tier: d.tier, profiles };
}

export interface LocationDeliveryState {
  nodeId: string;
  /** Канал локации заведён (у старых локаций, созданных до авто-выдачи, его может не быть). */
  wired: boolean;
  tier: number | null;
  inAuto: boolean;
  inCountry: boolean;
  countryProfile: string | null;
}

/** Текущее состояние выдачи для набора локаций — для строки в простом режиме. */
export async function readLocationDelivery(
  db: Database,
  org: string,
  nodes: Array<{ id: string; country: string | null }>,
): Promise<LocationDeliveryState[]> {
  if (nodes.length === 0) return [];
  const rows = await db
    .select({ tag: schema.channel.tag, remark: schema.profile.remark, tier: schema.profileChannel.tier })
    .from(schema.channel)
    .leftJoin(schema.profileChannel, eq(schema.profileChannel.channelId, schema.channel.id))
    .leftJoin(schema.profile, eq(schema.profile.id, schema.profileChannel.profileId))
    .where(and(eq(schema.channel.orgId, org), inArray(schema.channel.tag, nodes.map((n) => locationChannelTag(n.id)))));

  return nodes.map((n) => {
    const mine = rows.filter((r) => r.tag === locationChannelTag(n.id));
    const countryProfile = countryProfileRemark(n.country);
    const auto = mine.find((r) => r.remark === AUTO_PROFILE_REMARK);
    const country = countryProfile ? mine.find((r) => r.remark === countryProfile) : undefined;
    return {
      nodeId: n.id,
      wired: mine.length > 0,
      tier: auto?.tier ?? country?.tier ?? null,
      inAuto: Boolean(auto),
      inCountry: Boolean(country),
      countryProfile,
    };
  });
}
