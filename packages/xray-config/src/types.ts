// Доменные входные типы генератора. Xray-объекты держим слабо-типизированными (Record),
// строгую типизацию всей схемы Xray не тащим — это преждевременно.

export const VISION = "xtls-rprx-vision" as const;

/** Endpoint из подписки. reality по умолчанию; для CDN-fronting — security=tls + транспорт. */
export interface HostRef {
  address: string;
  port: number;
  sni: string; // reality serverName / TLS serverName (для CDN — CDN-домен)
  fingerprint: string; // firefox
  pbk: string; // reality public key
  sid: string; // shortId
  flow: string; // xtls-rprx-vision (пусто на grpc/xhttp)
  network?: string; // tcp | grpc | ws | xhttp
  /** reality (default) | tls (CDN-fronting: клиент шифрует TLS до CDN-домена). */
  security?: string;
  alpn?: string[];
  serviceName?: string; // grpc
  path?: string; // ws/xhttp
  host?: string; // ws/xhttp — Host-заголовок
}

/**
 * Канал профиля.
 * direct  — прямой outbound на foreign-exit.
 * cascade — клон exit-outbound с sockopt.dialerProxy=front; ОБА плеча flow=vision.
 */
export interface ChannelInput {
  kind: "direct" | "cascade";
  tag: string; // тег outbound'а = элемент селектора балансера (префиксный матч!)
  cc?: string;
  host: HostRef;
}

/** RU-front для client-chain каскада (dialerProxy target). */
export interface FrontOutbound {
  tag: string; // напр. "frontru2"
  host: HostRef; // reality :8443, flow=vision
}

/** Списки для geo-free split-routing (никаких geoip:/geosite:). */
export interface DomainList {
  zones: string[]; // ["ru","su","xn--p1ai"]
  domains: string[]; // сервисные РФ-домены (vk*, yandex*, банки, ...)
  ipCidrs?: string[]; // РФ IP-CIDR → freedom
}

/**
 * Профиль подписки — эшелоны по порядку: primary (tier1) → fallback (tier2) → reserve (tier3).
 * Внутри эшелона клиент выбирает канал сам; следующий эшелон включается, только когда
 * отказали все каналы предыдущего.
 */
export interface ProfileInput {
  remark: string; // "🔀 Авто" | "🇩🇪 Германия" | ...
  isAuto?: boolean;
  primary: string[]; // теги каналов tier1
  fallback: string[]; // теги каналов tier2 (может быть пусто → один тир)
  reserve?: string[]; // теги каналов tier3 — последний резерв
  /**
   * Выводить ли РФ-трафик мимо туннеля (default true).
   * false — для профилей вида «Россия» / «Белые списки», где РФ-ресурсы нужны
   * ЧЕРЕЗ туннель: правила РФ-доменов/CIDR не добавляются, DNS не разводится.
   */
  ruSplit?: boolean;
}

export interface GeneratorInput {
  vlessUuid: string; // per-client идентичность (единственный per-user секрет здесь)
  channels: ChannelInput[]; // все каналы (direct+cascade)
  front?: FrontOutbound; // если есть cascade-каналы
  domainList: DomainList;
  probeUrl?: string; // default https://cp.cloudflare.com/generate_204 (HTTPS!)
  probeInterval?: string; // default "10s"
}

export type XrayConfig = Record<string, unknown>;

export interface RenderedProfile {
  remark: string;
  config: XrayConfig;
}
