import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, gte, isNotNull, or } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import type { ChannelInput, DomainList, FrontOutbound, GeneratorInput, ProfileInput } from "@corelink/xray-config";
import { DB } from "../db/db.module.js";

export interface SubscriptionBundle {
  subscription: typeof schema.subscription.$inferSelect;
  input: GeneratorInput;
  profiles: ProfileInput[];
}

/** Что Happ присылает о себе заголовками x-hwid / x-device-os / x-ver-os / x-device-model. */
export interface DeviceInfo {
  hwid: string;
  deviceOs?: string;
  osVer?: string;
  deviceModel?: string;
  userAgent?: string;
}

@Injectable()
export class SubscriptionRepository {
  private readonly log = new Logger(SubscriptionRepository.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async findByShortUuid(
    orgId: string,
    shortUuid: string,
  ): Promise<typeof schema.subscription.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(schema.subscription)
      .where(and(eq(schema.subscription.orgId, orgId), eq(schema.subscription.shortUuid, shortUuid)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Легаси-путь `/api/sub/<id>`. У мигрируемых с Remnawave клиентов в сохранённых
   * ссылках стоит shortUuid, а не наш внутренний PK, поэтому сначала пробуем
   * shortUuid и только потом id — иначе в момент переключения вся легаси-база
   * молча получит заглушку «подписка не найдена».
   */
  async findById(orgId: string, id: string) {
    const byShortUuid = await this.findByShortUuid(orgId, id);
    if (byShortUuid) return byShortUuid;

    // внутренний PK — uuid; на произвольной строке Postgres бросит ошибку типа
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;

    const rows = await this.db
      .select()
      .from(schema.subscription)
      .where(and(eq(schema.subscription.orgId, orgId), eq(schema.subscription.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Отметка посещения: один UPDATE на выдачу. Без неё оператор не видит, ходит ли
   * клиент вообще, — в схеме поля были, а писать их было некому.
   */
  async markVisit(subscriptionId: string, userAgent: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(schema.subscription)
      .set({ subLastUserAgent: userAgent.slice(0, 256), subLastOpenedAt: now, onlineAt: now })
      .where(eq(schema.subscription.id, subscriptionId));
  }

  /**
   * Регистрация устройства при обращении к подписке. Идемпотентность — на unique
   * (subscription_id, hwid): повтор обновляет last_seen_at, а не плодит строки
   * и не ловит 23505 на гонке двух параллельных опросов одного клиента.
   */
  async touchDevice(orgId: string, subscriptionId: string, device: DeviceInfo): Promise<void> {
    const now = new Date();
    await this.db
      .insert(schema.subscriberDevice)
      .values({
        orgId,
        subscriptionId,
        hwid: device.hwid,
        deviceOs: device.deviceOs,
        osVer: device.osVer,
        deviceModel: device.deviceModel,
        userAgent: device.userAgent,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.subscriberDevice.subscriptionId, schema.subscriberDevice.hwid],
        // undefined-поля drizzle в SET не кладёт: клиент, переставший слать x-device-os,
        // не должен затирать то, что мы о нём уже знаем
        set: {
          lastSeenAt: now,
          deviceOs: device.deviceOs,
          osVer: device.osVer,
          deviceModel: device.deviceModel,
          userAgent: device.userAgent,
        },
      });
  }

  /**
   * Устройства, виденные внутри окна, в порядке появления.
   * Окно нужно, чтобы юзер, сменивший три телефона за год, не упирался в лимит
   * при одном живом устройстве. Второй ключ сортировки — hwid: у двух устройств,
   * заведённых в одну миллисекунду, порядок должен быть детерминированным,
   * иначе слот прыгал бы между ними от запроса к запросу.
   */
  async activeDeviceHwids(subscriptionId: string, since: Date): Promise<string[]> {
    const rows = await this.db
      .select({ hwid: schema.subscriberDevice.hwid })
      .from(schema.subscriberDevice)
      .where(
        and(
          eq(schema.subscriberDevice.subscriptionId, subscriptionId),
          gte(schema.subscriberDevice.lastSeenAt, since),
        ),
      )
      .orderBy(asc(schema.subscriberDevice.firstSeenAt), asc(schema.subscriberDevice.hwid));
    return rows.map((r) => r.hwid);
  }

  /** Собирает вход генератора: каналы+хосты, профили+tier'ы, front, список РФ-доменов. */
  async loadBundle(
    orgId: string,
    subscription: typeof schema.subscription.$inferSelect,
  ): Promise<SubscriptionBundle | null> {
    const all = await this.loadChannels(orgId);
    const open = await this.loadOpenInbounds(orgId, subscription.id);
    const channels = all.filter((c) => open.has(c.inboundId)).map((c) => c.channel);
    if (all.length > 0 && channels.length === 0) {
      this.log.warn(`подписка ${subscription.shortUuid}: ни одна локация не открыта её squad'ами — проверьте общий squad`);
    }
    const profiles = await this.loadProfiles(orgId, new Set(channels.map((c) => c.tag)));
    if (channels.length === 0 || profiles.length === 0) return null;

    const input: GeneratorInput = {
      vlessUuid: subscription.vlessUuid,
      channels,
      front: await this.loadFront(orgId),
      domainList: await this.loadDomainList(orgId),
    };
    return { subscription, input, profiles };
  }

  /**
   * Входы, открытые подписке: из общего squad'а (у всех) и из её собственных. Канал на
   * закрытом входе клиенту не показываем: нода его не пустит, а в конфиге он выглядел
   * бы рабочим — отдельный профиль страны из таких каналов был бы клиентом без интернета.
   */
  private async loadOpenInbounds(orgId: string, subscriptionId: string): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ inboundId: schema.squadInbound.inboundId })
      .from(schema.squadInbound)
      .innerJoin(schema.squad, eq(schema.squad.id, schema.squadInbound.squadId))
      .leftJoin(
        schema.subscriptionSquad,
        and(
          eq(schema.subscriptionSquad.squadId, schema.squad.id),
          eq(schema.subscriptionSquad.subscriptionId, subscriptionId),
        ),
      )
      .where(
        and(
          eq(schema.squad.orgId, orgId),
          or(eq(schema.squad.forAll, true), isNotNull(schema.subscriptionSquad.subscriptionId)),
        ),
      );
    return new Set(rows.map((r) => r.inboundId));
  }

  /**
   * Каналы, которые допустимо показывать клиенту прямо сейчас.
   * Отсекаем: хост без записи, выключенный/скрытый хост и каскад, у которого
   * не обе ноды применили конфиг (иначе балансер уведёт трафик в полу-собранную
   * цепочку — чёрную дыру без единого сообщения клиенту).
   * inboundId — вход хоста: по нему решается, открыт ли канал этой подписке.
   */
  private async loadChannels(orgId: string): Promise<Array<{ inboundId: string; channel: ChannelInput }>> {
    const rows = await this.db
      .select({ ch: schema.channel, host: schema.host, link: schema.cascadeLink, inbound: schema.inbound })
      .from(schema.channel)
      .leftJoin(schema.host, eq(schema.channel.hostId, schema.host.id))
      .leftJoin(schema.cascadeLink, eq(schema.channel.cascadeLinkId, schema.cascadeLink.id))
      // inbound несёт network/security/транспорт (CDN); без него клиент всегда получал бы tcp+reality
      .leftJoin(schema.inbound, eq(schema.host.inboundId, schema.inbound.id))
      .where(
        and(
          eq(schema.channel.orgId, orgId),
          eq(schema.host.isDisabled, false),
          eq(schema.host.isHidden, false),
        ),
      );

    return rows
      .filter((r) => r.host)
      // канал без привязки к каскаду — обычный direct, его не отсекаем
      .filter((r) => !r.ch.cascadeLinkId || r.link?.status === "active")
      .map(({ ch, host, inbound }) => ({
        inboundId: host!.inboundId,
        channel: {
          kind: ch.kind as "direct" | "cascade",
          tag: ch.newTag ?? ch.tag,
          cc: ch.cc ?? undefined,
          host: hostRef(host!, inbound),
        },
      }));
  }

  /**
   * Профили собираются ТОЛЬКО из фактически доступных каналов.
   * Если строить их независимо, отфильтрованный выше канал остался бы в профиле,
   * генератор бросил бы «channel not found» — и выдача легла бы у всей базы
   * из-за одного неактивного каскада.
   * Профиль, у которого не осталось каналов, выбрасываем целиком: балансер
   * с пустым селектором — это клиент без интернета и без сообщения об ошибке.
   */
  private async loadProfiles(orgId: string, availableTags: Set<string>): Promise<ProfileInput[]> {
    const profs = await this.db
      .select()
      .from(schema.profile)
      .where(eq(schema.profile.orgId, orgId))
      .orderBy(schema.profile.sortOrder);

    const pcs = await this.db
      .select({ pc: schema.profileChannel, ch: schema.channel })
      .from(schema.profileChannel)
      .innerJoin(schema.channel, eq(schema.profileChannel.channelId, schema.channel.id))
      .where(eq(schema.profileChannel.orgId, orgId));

    const profiles: ProfileInput[] = [];
    for (const p of profs) {
      const mine = pcs.filter((x) => x.pc.profileId === p.id);
      const tag = (x: (typeof mine)[number]) => x.ch.newTag ?? x.ch.tag;
      const pick = (tier: number) =>
        mine
          .filter((x) => x.pc.tier === tier)
          .sort(bySort)
          .map(tag)
          .filter((t) => availableTags.has(t));

      // Эшелоны 1-3; пустые схлопываем: если в tier1 не осталось доступных каналов,
      // первым эшелоном становится следующий непустой — клиент не остаётся без tier1.
      const tiers = [pick(1), pick(2), pick(3)].filter((t) => t.length > 0);
      if (tiers.length === 0) {
        this.log.warn(`профиль «${p.remark}» пропущен: не осталось доступных каналов`);
        continue;
      }
      profiles.push({
        remark: p.remark,
        isAuto: p.isAuto,
        ruSplit: p.ruSplit,
        primary: tiers[0],
        fallback: tiers[1] ?? [],
        ...(tiers[2] ? { reserve: tiers[2] } : {}),
      });
    }
    return profiles;
  }

  private async loadFront(orgId: string): Promise<FrontOutbound | undefined> {
    const rows = await this.db
      .select()
      .from(schema.host)
      .where(
        and(
          eq(schema.host.orgId, orgId),
          eq(schema.host.tagPrefix, "front"),
          eq(schema.host.isDisabled, false),
        ),
      )
      .limit(1);
    const h = rows[0];
    if (!h) return undefined;
    return { tag: "front", host: hostRef(h) };
  }

  private async loadDomainList(orgId: string): Promise<DomainList> {
    const lists = await this.db
      .select()
      .from(schema.routingDomainList)
      .where(eq(schema.routingDomainList.orgId, orgId))
      .orderBy(desc(schema.routingDomainList.version))
      .limit(1);
    const list = lists[0];
    if (!list) return { zones: [], domains: [] };

    const entries = await this.db
      .select()
      .from(schema.routingDomainEntry)
      .where(eq(schema.routingDomainEntry.listId, list.id));

    const domains: string[] = [];
    const ipCidrs: string[] = [];
    for (const e of entries) {
      if (e.kind === "cidr") ipCidrs.push(e.value);
      else if (e.kind === "regexp") domains.push(`regexp:${e.value}`);
      else if (e.kind === "full") domains.push(`full:${e.value}`);
      else domains.push(`domain:${e.value}`);
    }
    return { zones: [], domains, ipCidrs };
  }
}

function bySort(a: { pc: { sortOrder: number } }, b: { pc: { sortOrder: number } }): number {
  return a.pc.sortOrder - b.pc.sortOrder;
}

function hostRef(h: typeof schema.host.$inferSelect, inb?: typeof schema.inbound.$inferSelect | null) {
  const params = (inb?.params ?? {}) as { serviceName?: string; path?: string; host?: string };
  return {
    address: h.address,
    port: h.port,
    sni: h.sni ?? "",
    fingerprint: h.fingerprint ?? "firefox",
    pbk: h.pbk ?? "",
    sid: h.sid ?? "",
    flow: h.flow ?? "xtls-rprx-vision",
    network: inb?.network ?? "tcp",
    // нода за CDN стоит с security=none (CDN терминирует TLS), но клиент обязан шифровать
    // TLS до CDN-домена, иначе CDN его не примет: none на ноде → tls у клиента.
    security: (inb?.security ?? "reality") === "none" ? "tls" : (inb?.security ?? "reality"),
    ...(params.serviceName ? { serviceName: params.serviceName } : {}),
    ...(params.path ? { path: params.path } : {}),
    ...(params.host ? { host: params.host } : {}),
  };
}
