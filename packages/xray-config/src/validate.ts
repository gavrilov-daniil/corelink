import { VISION, type XrayConfig } from "./types.js";
import { PRIVATE_CIDRS } from "./split-routing.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

type Rule = Record<string, unknown>;

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strings(v: unknown): string[] {
  return arr(v).map(String);
}

const isBlockQuic = (r: Rule) =>
  r.outboundTag === "block" && String(r.network ?? "").includes("udp") && String(r.port ?? "") === "443";

const isBlockBittorrent = (r: Rule) => r.outboundTag === "block" && strings(r.protocol).includes("bittorrent");

const isPrivateIp = (r: Rule) =>
  r.outboundTag === "freedom" && strings(r.ip).some((c) => PRIVATE_CIDRS.includes(c));

// РФ-плечо split-routing: любой freedom по домену/IP, кроме правила приватных сетей
const isRuDirect = (r: Rule) =>
  r.outboundTag === "freedom" && !isPrivateIp(r) && (arr(r.domain).length > 0 || arr(r.ip).length > 0);

/**
 * Финальное правило «весь остальной трафик — туда».
 * Целью может быть и балансер, и конкретный outbound: профиль с единственным
 * каналом («Россия», «Белые списки») идёт вообще без балансеров.
 * Служебные freedom/block целью catch-all быть не могут — это означало бы,
 * что весь трафик уходит мимо туннеля или в никуда.
 */
const isCatchAll = (r: Rule) => {
  const target = r.balancerTag ?? r.outboundTag;
  if (!target || target === "freedom" || target === "block") return false;
  return !r.domain && !r.ip && !r.inboundTag && !r.protocol && !r.port;
};

/**
 * Инвариант-валидатор. Нарушение любого пункта = молчаливый отвал клиента,
 * поэтому конфиг НЕ публикуется, пока не пройдёт. Спайк 1 сверяет ещё и byte-diff с Remnawave.
 */
export function validateConfig(config: XrayConfig): ValidationResult {
  const errors: string[] = [];
  const routing = (config.routing ?? {}) as Record<string, unknown>;
  const outbounds = (config.outbounds ?? []) as Array<Record<string, unknown>>;
  const inbounds = (config.inbounds ?? []) as Array<Record<string, unknown>>;
  const balancers = (routing.balancers ?? []) as Array<Record<string, unknown>>;
  const rules = (routing.rules ?? []) as Rule[];
  const outboundTags = new Set(outbounds.map((o) => String(o.tag)));

  // 1. никаких geoip:/geosite: (валят XrayCore в Happ)
  const raw = JSON.stringify(config);
  if (/geoip:|geosite:/.test(raw)) {
    errors.push("найдено geoip:/geosite: — в Happ нет geo-баз, XrayCore упадёт");
  }

  // 2. freedom-outbound назван ровно "freedom"
  if (!outboundTags.has("freedom")) {
    errors.push('нет outbound с тегом "freedom" (локальный direct для РФ-трафика)');
  }

  // 3. селектор балансера префиксный: ни один префикс не должен цеплять "freedom",
  //    и каждый элемент селектора должен резолвиться в существующий outbound.
  for (const b of balancers) {
    const sel = strings(b.selector);
    // балансер без кандидатов = у клиента просто нет интернета, и он об этом не узнает
    if (sel.length === 0) {
      errors.push(`балансер "${b.tag}" с пустым селектором — трафику некуда идти`);
    }
    for (const s of sel) {
      if ("freedom".startsWith(s)) {
        errors.push(`селектор балансера "${b.tag}" содержит "${s}" — префиксно зацепит freedom, рунет уйдёт в туннель`);
      }
      const matches = [...outboundTags].some((tag) => tag.startsWith(s));
      if (!matches) errors.push(`селектор "${s}" балансера "${b.tag}" не матчит ни один outbound`);
    }
    // Стратегия: осмысленны leastPing и random, случайную строку не пропускаем.
    // Требовать leastPing ОТ ВСЕХ балансеров нельзя: в боевой конфигурации
    // резервный тир каскадов идёт с random (все плечи равнозначны, а лишние
    // пробы через каскад дороги). Спайк golden-diff показал, что такая проверка
    // отвергала бы реальный рабочий конфиг.
    const strategy = (b.strategy ?? {}) as Record<string, unknown>;
    const strategyType = String(strategy.type ?? "");
    if (strategyType !== "leastPing" && strategyType !== "random") {
      errors.push(
        `балансер "${b.tag}": strategy.type должен быть "leastPing" или "random" (сейчас "${strategy.type ?? "нет"}")`,
      );
    }
    // Первичный тир обязан мерить задержку — иначе failover направляет трафик наугад.
    if (b.fallbackTag && strategyType !== "leastPing") {
      errors.push(
        `балансер "${b.tag}" с fallbackTag обязан быть leastPing: это первичный тир, он выбирает лучший канал`,
      );
    }
  }

  // 3b. префиксная коллизия между балансерами: тег, попавший в оба селектора,
  //     схлопывает тиры в один (tier1 "de" захватывает "de-cascade" из tier2) — failover исчезает молча.
  for (let i = 0; i < balancers.length; i++) {
    for (let j = i + 1; j < balancers.length; j++) {
      const selA = strings(balancers[i].selector);
      const selB = strings(balancers[j].selector);
      for (const tag of outboundTags) {
        const hitA = selA.find((s) => tag.startsWith(s));
        const hitB = selB.find((s) => tag.startsWith(s));
        if (hitA !== undefined && hitB !== undefined) {
          errors.push(
            `outbound "${tag}" захвачен селекторами "${hitA}" (балансер "${balancers[i].tag}") и "${hitB}" (балансер "${balancers[j].tag}") — тиры вырождаются в один, failover исчезает`,
          );
        }
      }
    }
  }

  // 4. loopback-цепочка целостна; последний tier — без fallbackTag
  const balancerByTag = new Map(balancers.map((b) => [String(b.tag), b]));
  const loopbackOutByTag = new Map(
    outbounds.filter((o) => o.protocol === "loopback").map((o) => [String(o.tag), o]),
  );
  const dokodemoByTag = new Map(
    inbounds.filter((i) => i.protocol === "dokodemo-door").map((i) => [String(i.tag), i]),
  );
  const catchAllIdx = rules.findIndex(isCatchAll);
  let terminalCount = 0;
  for (const b of balancers) {
    const fb = b.fallbackTag as string | undefined;
    if (!fb) {
      terminalCount++;
      continue;
    }
    const lo = loopbackOutByTag.get(fb);
    if (!lo) {
      errors.push(`balancer "${b.tag}" fallbackTag="${fb}" не ссылается на loopback-outbound`);
      continue;
    }
    const loInTag = String((lo.settings as Record<string, unknown>)?.inboundTag ?? "");
    const dk = dokodemoByTag.get(loInTag);
    if (!dk) {
      errors.push(`loopback "${fb}" → inboundTag "${loInTag}" не найден как dokodemo-door`);
      continue;
    }
    if (dk.listen !== "127.0.0.1" || dk.port !== 0) {
      errors.push(`dokodemo "${loInTag}" должен быть listen 127.0.0.1, port 0`);
    }
    const net = String((dk.settings as Record<string, unknown>)?.network ?? "");
    if (!net.includes("tcp") || !net.includes("udp")) {
      errors.push(`dokodemo "${loInTag}" network должен быть "tcp,udp" (сейчас "${net}")`);
    }
    const reinjectIdx = rules.findIndex(
      (r) => strings(r.inboundTag).includes(loInTag) && Boolean(r.balancerTag),
    );
    if (reinjectIdx === -1) {
      errors.push(`нет routing-rule inboundTag:["${loInTag}"] → следующий tier (loopback молча сломан)`);
    } else if (catchAllIdx !== -1 && reinjectIdx > catchAllIdx) {
      errors.push(`реинжект inboundTag:["${loInTag}"] стоит после catch-all — до него трафик не дойдёт, tier2 мёртв`);
    }
  }
  if (balancers.length > 0 && terminalCount === 0) {
    errors.push("нет ни одного балансера без fallbackTag — вечная петля реинжекта при полном отказе");
  }

  // 5. routing balancerTag ссылается на существующий балансер
  for (const r of rules) {
    if (r.balancerTag && !balancerByTag.has(String(r.balancerTag))) {
      errors.push(`routing-rule ссылается на несуществующий balancerTag "${r.balancerTag}"`);
    }
  }

  // 6. observatory top-level, subjectSelector ⊇ union всех selector, probeUrl по https
  if (config.burstObservatory) {
    errors.push("burstObservatory не использовать (баг Xray #5897) — только top-level observatory");
  }
  const obs = config.observatory as Record<string, unknown> | undefined;
  // Профиль с единственным каналом идёт без балансера (как боевые «Россия» и
  // «Белые списки») — измерять там нечего, отсутствие observatory это норма.
  if (!obs && balancers.length > 0) {
    errors.push("нет top-level observatory (burstObservatory не использовать — баг Xray #5897)");
  } else if (obs) {
    const subj = new Set(strings(obs.subjectSelector));
    for (const b of balancers) {
      for (const s of strings(b.selector)) {
        if (!subj.has(s)) errors.push(`observatory.subjectSelector не содержит "${s}" — забытая нода не меряется`);
      }
    }
    const probeUrl = String(obs.probeUrl ?? "");
    if (!probeUrl.startsWith("https://")) {
      errors.push(
        `observatory.probeUrl должен быть https (сейчас "${probeUrl}") — на http провайдерская заглушка засчитается за живую ноду`,
      );
    }
  }

  // 7. domainStrategy AsIs
  if (routing.domainStrategy && routing.domainStrategy !== "AsIs") {
    errors.push(`routing.domainStrategy должен быть "AsIs" (сейчас "${routing.domainStrategy}")`);
  }

  // 8. порядок head-правил: приватные CIDR → bittorrent → udp:443 → РФ → catch-all.
  //    Регресс порядка не ломает конфиг синтаксически: рунет просто уезжает в туннель (или наоборот).
  const quicIdx = rules.findIndex(isBlockQuic);
  const btIdx = rules.findIndex(isBlockBittorrent);
  const privIdx = rules.findIndex(isPrivateIp);
  const ruIdxs = rules.map((r, i) => (isRuDirect(r) ? i : -1)).filter((i) => i >= 0);

  if (quicIdx === -1) errors.push("нет правила block udp:443 — QUIC пойдёт мимо split-routing");
  if (btIdx === -1) errors.push("нет правила block bittorrent");
  if (privIdx === -1) errors.push("нет правила приватные CIDR → freedom — локальная сеть уедет в туннель");
  if (catchAllIdx === -1) errors.push("нет catch-all правила — весь незаматченный трафик встанет");

  // Порядок сверен с боевой выдачей действующей панели (спайк golden-diff):
  // приватные сети идут ПЕРВЫМИ — локальный трафик не должен зависеть ни от
  // блокировок, ни от РФ-списков; затем блокировки; затем РФ; последним catch-all.
  const order: Array<[string, number]> = [];
  if (privIdx !== -1) order.push(["приватные CIDR → freedom", privIdx]);
  if (btIdx !== -1) order.push(["block bittorrent", btIdx]);
  if (quicIdx !== -1) order.push(["block udp:443", quicIdx]);
  if (ruIdxs.length) {
    order.push(["РФ → freedom", ruIdxs[0]]);
    if (ruIdxs.length > 1) order.push(["РФ → freedom (последнее)", ruIdxs[ruIdxs.length - 1]]);
  }
  if (catchAllIdx !== -1) order.push(["catch-all → балансер", catchAllIdx]);
  for (let i = 1; i < order.length; i++) {
    if (order[i][1] < order[i - 1][1]) {
      errors.push(`порядок split-routing нарушен: "${order[i][0]}" стоит раньше "${order[i - 1][0]}"`);
    }
  }
  if (catchAllIdx !== -1 && catchAllIdx !== rules.length - 1) {
    errors.push(`правила после catch-all (индекс ${catchAllIdx} из ${rules.length}) недостижимы`);
  }

  // 9. sniffing.routeOnly на пользовательских inbound: без него Xray подменяет адрес
  //    назначения на сниффнутый домен — ломается direct-матч по IP и рвётся Reality/Vision.
  for (const i of inbounds) {
    if (i.protocol !== "socks" && i.protocol !== "http") continue;
    const sn = (i.sniffing ?? {}) as Record<string, unknown>;
    if (sn.enabled !== true) {
      errors.push(`inbound "${i.tag}": sniffing выключен — домены не определятся, split-routing развалится`);
    } else if (sn.routeOnly !== true) {
      errors.push(`inbound "${i.tag}": sniffing.routeOnly !== true — подмена адреса назначения рвёт Reality/Vision`);
    }
  }

  // 10. queryStrategy UseIPv4 — иначе AAAA-ответы уходят мимо split-routing
  const dns = config.dns as Record<string, unknown> | undefined;
  if (!dns) {
    errors.push("нет секции dns");
  } else if (dns.queryStrategy !== "UseIPv4") {
    errors.push(`dns.queryStrategy должен быть "UseIPv4" (сейчас "${dns.queryStrategy}") — AAAA утечёт мимо split-routing`);
  }

  // 11. flow: на tcp+reality обязателен Vision (пустой рвёт хендшейк после VLESS-хедера,
  //     в т.ч. на ОБОИХ плечах каскада), на grpc/xhttp — наоборот, обязан быть пустым.
  for (const o of outbounds) {
    if (o.protocol !== "vless") continue;
    const stream = (o.streamSettings ?? {}) as Record<string, unknown>;
    const network = String(stream.network ?? "tcp");
    const visionExpected = network === "tcp" && stream.security === "reality";
    for (const v of arr((o.settings as Record<string, unknown>)?.vnext) as Array<Record<string, unknown>>) {
      for (const u of arr(v.users) as Array<Record<string, unknown>>) {
        const flow = String(u.flow ?? "");
        if (visionExpected && flow !== VISION) {
          errors.push(`outbound "${o.tag}": на tcp+reality flow должен быть "${VISION}" (сейчас "${flow}") — Vision-хендшейк порвётся`);
        }
        if (!visionExpected && flow) {
          errors.push(`outbound "${o.tag}": на ${network} flow должен быть пустым (сейчас "${flow}")`);
        }
      }
    }
    // 12. reality без публичного ключа: XrayCore не стартует вовсе («empty password») —
    //     падает весь конфиг, а не один канал
    if (stream.security === "reality") {
      const reality = (stream.realitySettings ?? {}) as Record<string, unknown>;
      if (!reality.publicKey && !reality.password) {
        errors.push(`outbound "${o.tag}": reality без publicKey — XrayCore не стартует, весь конфиг мёртв`);
      }
    }
    const dialerProxy = ((stream.sockopt ?? {}) as Record<string, unknown>).dialerProxy;
    if (dialerProxy && !outboundTags.has(String(dialerProxy))) {
      errors.push(`outbound "${o.tag}": dialerProxy="${dialerProxy}" не существует — каскад никуда не подключится`);
    }
  }

  return { ok: errors.length === 0, errors };
}
