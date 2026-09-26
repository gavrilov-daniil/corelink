/**
 * Общий стенд для тестов apps/core, которым нужен живой Postgres.
 *
 * Изоляция — собственный org_id на процесс. Весь core фильтрует запросы по
 * DEFAULT_ORG_ID, поэтому тестовые данные не видят ни импортированную в dev-базу
 * боевую выборку, ни данные соседнего тестового файла (node --test запускает
 * каждый файл своим процессом). Порядок тестов при этом ни на что не влияет.
 *
 * Имя файла *.test.ts намеренное: тестовое окружение не должно попадать в сборку,
 * а tsconfig.build.json исключает ровно этот паттерн. Тестов здесь нет — только хелперы.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, schema, type Database } from "@corelink/db";
import { encryptCredentials } from "@corelink/core-kit";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://vpn:vpn@localhost:5442/vpn_platform";

export const TEST_ORG_ID = randomUUID();
export const MASTER_KEY = "core-tests-master-key-0123456789";
export const PARITYPAY_WEBHOOK_SECRET = "test-webhook-secret";

// Выставляем ДО конструирования сервисов: loadConfig() читается в поле класса.
process.env.DEFAULT_ORG_ID = TEST_ORG_ID;
process.env.SECRETS_MASTER_KEY = MASTER_KEY;
// Лимитер должен считать в памяти процесса, иначе тесты зависят от состояния Redis.
delete process.env.REDIS_URL;

export function openDb(): Database {
  return createDb(TEST_DATABASE_URL);
}

export async function closeDb(db: Database): Promise<void> {
  await db.$client.end();
}

const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomLinkCode(): string {
  let out = "";
  for (let i = 0; i < 6; i += 1) out += LINK_CODE_ALPHABET[Math.floor(Math.random() * LINK_CODE_ALPHABET.length)];
  return out;
}

const uniqueSuffix = () => randomUUID().slice(0, 8);

export async function createSubscriber(db: Database, patch: Partial<typeof schema.subscriber.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.subscriber)
    .values({
      orgId: TEST_ORG_ID,
      // telegram_id уникален в пределах org, а org у каждого процесса свой
      telegramId: Math.floor(Math.random() * 2 ** 40),
      username: `t-${uniqueSuffix()}`,
      ...patch,
    })
    .returning();
  return row;
}

export async function createSubscription(
  db: Database,
  subscriberId: string,
  patch: Partial<typeof schema.subscription.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.subscription)
    .values({
      orgId: TEST_ORG_ID,
      subscriberId,
      shortUuid: `su-${randomUUID().replace(/-/g, "")}`,
      status: "active",
      vlessUuid: randomUUID(),
      trafficLimitBytes: 100 * 1024 ** 3,
      usedTrafficBytes: 5 * 1024 ** 3,
      ...patch,
    })
    .returning();
  return row;
}

export async function createPlan(db: Database, patch: Partial<typeof schema.plan.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.plan)
    .values({
      orgId: TEST_ORG_ID,
      code: `plan-${uniqueSuffix()}`,
      title: "Тест-тариф",
      periodDays: 30,
      priceKopeks: 50_000,
      ...patch,
    })
    .returning();
  return row;
}

export async function createPayment(db: Database, patch: Partial<typeof schema.payment.$inferInsert> & { subscriberId: string }) {
  const [row] = await db
    .insert(schema.payment)
    .values({
      orgId: TEST_ORG_ID,
      provider: "paritypay",
      providerPaymentId: `ord-${randomUUID()}`,
      purpose: "topup",
      amountKopeks: 50_000,
      status: "pending",
      ...patch,
    })
    .returning();
  return row;
}

export async function createMerchant(db: Database, patch: Partial<typeof schema.paymentMerchant.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.paymentMerchant)
    .values({
      orgId: TEST_ORG_ID,
      provider: "paritypay",
      alias: `merchant-${uniqueSuffix()}`,
      isEnabled: true,
      mode: "test",
      credentials: encryptCredentials(
        { shop_id: "42", api_key: "api-key", webhook_secret: PARITYPAY_WEBHOOK_SECRET },
        MASTER_KEY,
      ),
      purposes: ["topup", "plan"],
      ...patch,
    })
    .returning();
  return row;
}

export async function createCampaignLink(db: Database, patch: Partial<typeof schema.campaignLink.$inferInsert> = {}) {
  const [campaign] = await db
    .insert(schema.campaign)
    .values({ orgId: TEST_ORG_ID, slug: `camp-${uniqueSuffix()}`, name: "Тест-кампания" })
    .returning();
  const [link] = await db
    .insert(schema.campaignLink)
    .values({ orgId: TEST_ORG_ID, campaignId: campaign.id, code: randomLinkCode(), ...patch })
    .returning();
  return link;
}

export async function createSquad(db: Database, name = `squad-${uniqueSuffix()}`) {
  const [row] = await db.insert(schema.squad).values({ orgId: TEST_ORG_ID, name }).returning();
  return row;
}

/**
 * Подпись вебхука ParityPay считается здесь независимо от кода адаптера:
 * тест не должен подтверждать сам себя чужой реализацией той же формулы.
 */
export function paritypayWebhook(input: {
  orderId: string;
  status: string;
  amountRub: number;
  invoiceId?: string;
  secret?: string;
  breakSignature?: boolean;
}) {
  const payload: Record<string, unknown> = {
    id: input.invoiceId ?? `inv-${uniqueSuffix()}`,
    order_id: input.orderId,
    status: input.status,
    amount: input.amountRub,
  };
  const concat = Object.keys(payload)
    .sort()
    .map((k) => String(payload[k]))
    .join("");
  const signature = createHmac("sha256", input.secret ?? PARITYPAY_WEBHOOK_SECRET).update(concat).digest("hex");
  return {
    rawBody: JSON.stringify(payload),
    headers: { "x-signature": input.breakSignature ? "deadbeef".repeat(8) : signature },
  };
}

/**
 * Подписанная полезная нагрузка Telegram Login Widget. Формула считается здесь
 * независимо от кода проверки — по той же причине, что и подпись ParityPay выше.
 */
export function telegramWidgetPayload(
  fields: Record<string, string | number>,
  botToken: string,
): Record<string, string | number> {
  const checkString = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort()
    .join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  return { ...fields, hash: createHmac("sha256", secret).update(checkString).digest("hex") };
}

export interface ChannelSpec {
  key: string;
  kind: "direct" | "cascade";
  tag: string;
  cc?: string;
  /** Статус каскадной связки. Задан — у канала появляется cascade_link с этим статусом. */
  cascadeStatus?: "planned" | "exit_ready" | "relay_ready" | "active" | "retiring";
  hostDisabled?: boolean;
  hostHidden?: boolean;
  /** Тег отдельного входа под этот канал. Такой вход НЕ в общем squad'е — доступ к нему тест раздаёт сам. */
  inbound?: string;
}

export interface ProfileSpec {
  remark: string;
  isAuto?: boolean;
  ruSplit?: boolean;
  primary: string[];
  fallback?: string[];
  reserve?: string[]; // tier 3
}

export interface NetworkSpec {
  channels: ChannelSpec[];
  profiles: ProfileSpec[];
  /** RU-front (host с tagPrefix "front"). Без него каскадный канал уронит генератор. */
  withFront?: boolean;
  /**
   * Общий squad с основным входом — как в проде, где мастер кладёт локацию в него.
   * По умолчанию есть: без доступа выдача отфильтрует все каналы.
   */
  generalAccess?: boolean;
}

/** Сервер + нода + inbound + хосты + каналы + профили: минимальный полный вход генератора. */
export async function seedNetwork(db: Database, spec: NetworkSpec) {
  const reality = { sni: "ads.x5.ru", fingerprint: "firefox", flow: "xtls-rprx-vision" };

  const [server] = await db
    .insert(schema.server)
    .values({ orgId: TEST_ORG_ID, hostname: `srv-${uniqueSuffix()}`, primaryIp: "203.0.113.10", country: "DE" })
    .returning();
  const [configProfile] = await db
    .insert(schema.configProfile)
    .values({ orgId: TEST_ORG_ID, name: `cfg-${uniqueSuffix()}` })
    .returning();
  const [node] = await db
    .insert(schema.node)
    .values({
      orgId: TEST_ORG_ID,
      serverId: server.id,
      configProfileId: configProfile.id,
      name: `node-${uniqueSuffix()}`,
      roles: ["exit", "front"],
      status: "active",
    })
    .returning();
  const [inbound] = await db
    .insert(schema.inbound)
    .values({ orgId: TEST_ORG_ID, configProfileId: configProfile.id, tag: "VLESS_REALITY_TEST", port: 443, ...reality })
    .returning();

  if (spec.generalAccess !== false) {
    const [general] = await db
      .insert(schema.squad)
      .values({ orgId: TEST_ORG_ID, name: "Общий", forAll: true })
      .returning();
    await db.insert(schema.squadInbound).values({ squadId: general.id, inboundId: inbound.id });
  }

  const inboundIdByTag = new Map<string, string>([[inbound.tag, inbound.id]]);
  const inboundFor = async (tag: string | undefined): Promise<string> => {
    const known = inboundIdByTag.get(tag ?? inbound.tag);
    if (known) return known;
    const [extra] = await db
      .insert(schema.inbound)
      .values({ orgId: TEST_ORG_ID, configProfileId: configProfile.id, tag: tag!, port: 443 + inboundIdByTag.size, ...reality })
      .returning();
    inboundIdByTag.set(extra.tag, extra.id);
    return extra.id;
  };

  if (spec.withFront !== false) {
    await db.insert(schema.host).values({
      orgId: TEST_ORG_ID,
      inboundId: inbound.id,
      nodeId: node.id,
      remark: "RU-front",
      address: "203.0.113.30",
      port: 8443,
      pbk: "PBK_FRONT",
      sid: "fr01",
      tagPrefix: "front",
      ...reality,
    });
  }

  const channelIdByKey = new Map<string, string>();
  let octet = 100;
  for (const ch of spec.channels) {
    octet += 1;
    const [host] = await db
      .insert(schema.host)
      .values({
        orgId: TEST_ORG_ID,
        inboundId: await inboundFor(ch.inbound),
        nodeId: node.id,
        remark: ch.tag,
        address: `203.0.113.${octet}`,
        port: 443,
        pbk: `PBK_${ch.tag}`,
        sid: "aa01",
        isDisabled: ch.hostDisabled ?? false,
        isHidden: ch.hostHidden ?? false,
        ...reality,
      })
      .returning();

    let cascadeLinkId: string | undefined;
    if (ch.cascadeStatus) {
      const [link] = await db
        .insert(schema.cascadeLink)
        .values({
          orgId: TEST_ORG_ID,
          kind: "client_chain",
          cc: ch.cc ?? "XX",
          exitNodeId: node.id,
          exitInboundTag: inbound.tag,
          linkUserUuid: randomUUID(),
          status: ch.cascadeStatus,
        })
        .returning();
      cascadeLinkId = link.id;
    }

    const [channel] = await db
      .insert(schema.channel)
      .values({
        orgId: TEST_ORG_ID,
        kind: ch.kind,
        tag: ch.tag,
        newTag: ch.kind === "cascade" ? ch.tag : null,
        cc: ch.cc,
        hostId: host.id,
        cascadeLinkId,
      })
      .returning();
    channelIdByKey.set(ch.key, channel.id);
  }

  let sortOrder = 0;
  for (const p of spec.profiles) {
    const [profile] = await db
      .insert(schema.profile)
      .values({
        orgId: TEST_ORG_ID,
        remark: p.remark,
        sortOrder: sortOrder++,
        isAuto: p.isAuto ?? false,
        ruSplit: p.ruSplit ?? true,
      })
      .returning();

    const rows = [
      ...p.primary.map((key, i) => ({ key, tier: 1, sortOrder: i })),
      ...(p.fallback ?? []).map((key, i) => ({ key, tier: 2, sortOrder: i })),
      ...(p.reserve ?? []).map((key, i) => ({ key, tier: 3, sortOrder: i })),
    ];
    for (const r of rows) {
      const channelId = channelIdByKey.get(r.key);
      if (!channelId) throw new Error(`фикстура профиля «${p.remark}» ссылается на неизвестный канал ${r.key}`);
      await db.insert(schema.profileChannel).values({
        orgId: TEST_ORG_ID,
        profileId: profile.id,
        channelId,
        tier: r.tier,
        sortOrder: r.sortOrder,
      });
    }
  }

  const [list] = await db
    .insert(schema.routingDomainList)
    .values({ orgId: TEST_ORG_ID, name: "ru_direct", version: 1, sourceUrl: "test" })
    .returning();
  await db.insert(schema.routingDomainEntry).values([
    { listId: list.id, kind: "domain", value: "ru" },
    { listId: list.id, kind: "domain", value: "vk.com" },
    { listId: list.id, kind: "cidr", value: "77.88.0.0/18" },
  ]);

  return { server, node, inbound, configProfile, channelIdByKey, inboundIdByTag };
}

/**
 * Полная зачистка org'а теста. Порядок — от детей к родителям: FK в схеме без
 * ON DELETE CASCADE, и «почти правильный» порядок молча оставил бы мусор,
 * который сломал бы следующий прогон.
 */
export async function cleanupOrg(db: Database): Promise<void> {
  const org = TEST_ORG_ID;
  const statements = [
    sql`delete from campaign_event where org_id = ${org}`,
    sql`delete from ledger_entry where org_id = ${org}`,
    sql`delete from subscription_activation where org_id = ${org}`,
    sql`delete from referral_reward where org_id = ${org}`,
    sql`delete from promo_redemption where org_id = ${org}`,
    sql`delete from payment where org_id = ${org}`,
    sql`delete from payment_merchant where org_id = ${org}`,
    sql`delete from plan where org_id = ${org}`,
    sql`delete from campaign_link where org_id = ${org}`,
    sql`delete from campaign where org_id = ${org}`,
    // мониторинг ссылается на служебную подписку пробы — до подписок
    sql`delete from monitor_event where org_id = ${org}`,
    sql`delete from probe_result where org_id = ${org}`,
    sql`delete from monitor_probe where org_id = ${org}`,
    sql`delete from subscriber_device where org_id = ${org}`,
    sql`delete from subscription_squad where subscription_id in (select id from subscription where org_id = ${org})`,
    sql`delete from squad_inbound where squad_id in (select id from squad where org_id = ${org})`,
    sql`delete from squad where org_id = ${org}`,
    sql`delete from subscription_config_snapshot where org_id = ${org}`,
    sql`delete from profile_channel where org_id = ${org}`,
    sql`delete from profile where org_id = ${org}`,
    sql`delete from channel where org_id = ${org}`,
    sql`delete from cascade_link where org_id = ${org}`,
    sql`delete from host where org_id = ${org}`,
    sql`delete from inbound where org_id = ${org}`,
    sql`delete from routing_domain_entry where list_id in (select id from routing_domain_list where org_id = ${org})`,
    sql`delete from routing_domain_list where org_id = ${org}`,
    sql`delete from subscription where org_id = ${org}`,
    sql`delete from subscriber where org_id = ${org}`,
    // трафик тоже ссылается на ноду: без этих трёх строк удаление ноды падает по FK
    // у любого теста, который дошёл до приёма статистики или сам положил агрегат
    sql`delete from traffic_daily where org_id = ${org}`,
    sql`delete from traffic_sample where org_id = ${org}`,
    sql`delete from traffic_report where org_id = ${org}`,
    // состояние ноды 1:1 и без ON DELETE CASCADE — без этих трёх строк удаление
    // ноды падает по FK у любого теста, который дошёл до сборки desired-state
    sql`delete from node_identity where node_id in (select id from node where org_id = ${org})`,
    sql`delete from node_desired_state where node_id in (select id from node where org_id = ${org})`,
    sql`delete from node_reported_state where node_id in (select id from node where org_id = ${org})`,
    sql`delete from node where org_id = ${org}`,
    sql`delete from config_profile where org_id = ${org}`,
    sql`delete from server where org_id = ${org}`,
    // сессии до учёток: operator_session ссылается на user
    sql`delete from operator_session where org_id = ${org}`,
    sql`delete from "user" where org_id = ${org}`,
    sql`delete from telegram_auth_setting where org_id = ${org}`,
  ];
  for (const statement of statements) await db.execute(statement);
}
