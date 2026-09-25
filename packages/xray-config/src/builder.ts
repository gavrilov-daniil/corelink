import type {
  ChannelInput,
  FrontOutbound,
  GeneratorInput,
  HostRef,
  ProfileInput,
  RenderedProfile,
  XrayConfig,
} from "./types.js";
import { VISION } from "./types.js";
import {
  DEFAULT_PROBE_INTERVAL,
  DEFAULT_PROBE_URL,
  buildDns,
  buildSplitRoutingHead,
} from "./split-routing.js";

// Пользовательские inbound'ы клиента (socks + http), sniffing routeOnly (иначе ломается direct-матч по IP).
function userInbounds(): Array<Record<string, unknown>> {
  const sniffing = { enabled: true, destOverride: ["http", "tls", "quic"], routeOnly: true };
  return [
    { tag: "socks-in", listen: "127.0.0.1", port: 10808, protocol: "socks", settings: { udp: true }, sniffing },
    { tag: "http-in", listen: "127.0.0.1", port: 10809, protocol: "http", sniffing },
  ];
}

/** Транспорт-блок клиентского stream по network. tcp — пусто. */
function transportStream(host: HostRef): Record<string, unknown> | null {
  switch (host.network) {
    case "grpc":
      return { grpcSettings: { serviceName: host.serviceName ?? "" } };
    case "ws":
      return { wsSettings: { path: host.path ?? "/", ...(host.host ? { headers: { Host: host.host } } : {}) } };
    case "xhttp":
      return { xhttpSettings: { path: host.path ?? "/", ...(host.host ? { host: host.host } : {}) } };
    default:
      return null; // tcp
  }
}

/**
 * streamSettings клиентского outbound. reality — как раньше (байт-в-байт, иначе разъедется
 * golden-diff). tls — CDN-fronting: клиент шифрует TLS до host.address (CDN-домена) поверх
 * транспорта (grpc/ws/xhttp).
 */
function clientStream(host: HostRef, dialerProxyTag?: string): Record<string, unknown> {
  const security = host.security ?? "reality";
  const stream: Record<string, unknown> = { network: host.network ?? "tcp" };
  if (security === "reality") {
    stream.security = "reality";
    stream.realitySettings = {
      serverName: host.sni,
      fingerprint: host.fingerprint,
      publicKey: host.pbk,
      shortId: host.sid,
    };
  } else {
    stream.security = "tls";
    stream.tlsSettings = {
      serverName: host.sni,
      fingerprint: host.fingerprint,
      ...(host.alpn ? { alpn: host.alpn } : {}),
    };
  }
  const transport = transportStream(host);
  if (transport) Object.assign(stream, transport);
  if (dialerProxyTag) stream.sockopt = { dialerProxy: dialerProxyTag };
  return stream;
}

function vlessOutbound(tag: string, uuid: string, host: HostRef, dialerProxyTag?: string): Record<string, unknown> {
  return {
    tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: host.address,
          port: host.port,
          users: [{ id: uuid, encryption: "none", flow: host.flow || "" }],
        },
      ],
    },
    streamSettings: clientStream(host, dialerProxyTag),
  };
}

function channelOutbound(ch: ChannelInput, input: GeneratorInput): Record<string, unknown> {
  if (ch.kind === "direct") {
    return vlessOutbound(ch.tag, input.vlessUuid, ch.host);
  }
  // cascade: клон exit-outbound с dialerProxy=front, ОБА плеча flow=vision
  if (!input.front) {
    throw new Error(`cascade channel ${ch.tag} requires a front outbound`);
  }
  return vlessOutbound(ch.tag, input.vlessUuid, ch.host, input.front.tag);
}

function frontOutbound(front: FrontOutbound, uuid: string): Record<string, unknown> {
  return vlessOutbound(front.tag, uuid, front.host);
}

const FREEDOM = { tag: "freedom", protocol: "freedom", settings: { domainStrategy: "UseIPv4" } };
const BLOCK = { tag: "block", protocol: "blackhole" };

/** Строит ОДИН полный Xray-конфиг для профиля (свой балансер, observatory, loopback, split). */
export function buildProfileConfig(input: GeneratorInput, profile: ProfileInput): XrayConfig {
  const byTag = new Map(input.channels.map((c) => [c.tag, c]));
  // Эшелоны по порядку: tier1 → tier2 → tier3. Пустые выбрасываем: балансер с пустым
  // селектором — клиент без интернета, а переход в пустой эшелон — петля реинжекта.
  const tiers = [profile.primary, profile.fallback, profile.reserve ?? []]
    .filter((t) => t.length > 0)
    .map((t) => t.map((tag) => must(byTag, tag)));
  const channels = tiers.flat();
  const hasCascade = channels.some((c) => c.kind === "cascade");
  // переход k: эшелон k → эшелон k+1 через loopback lo-out-k → lo-in-k
  const hops = Math.max(tiers.length - 1, 0);

  // --- outbounds ---
  const outbounds: Array<Record<string, unknown>> = channels.map((ch) => channelOutbound(ch, input));
  if (hasCascade && input.front) outbounds.push(frontOutbound(input.front, input.vlessUuid));
  outbounds.push({ ...FREEDOM });
  outbounds.push({ ...BLOCK });
  for (let k = 1; k <= hops; k++) {
    outbounds.push({ tag: `lo-out-${k}`, protocol: "loopback", settings: { inboundTag: `lo-in-${k}` } });
  }

  // --- inbounds ---
  const inbounds = userInbounds();
  for (let k = 1; k <= hops; k++) {
    inbounds.push({
      tag: `lo-in-${k}`,
      listen: "127.0.0.1",
      port: 0,
      protocol: "dokodemo-door",
      settings: { network: "tcp,udp", followRedirect: true },
    });
  }

  // Единственный канал без резерва — балансер не нужен: трафик идёт прямо в outbound.
  // Так устроены боевые профили «Россия» и «Белые списки» (сверено спайком golden-diff).
  // Балансер из одного кандидата не даёт ничего, но тянет за собой observatory
  // и лишние пробы через канал.
  const singleChannel = tiers.length === 1 && tiers[0].length === 1 ? tiers[0][0] : null;

  // --- balancers: по одному на эшелон. Все, кроме последнего, — leastPing с переходом на
  // следующий через loopback. Последний — БЕЗ fallbackTag (иначе вечная петля реинжекта),
  // а при нескольких эшелонах — random: резервные плечи равнозначны, пробы через них
  // дороги. Так 2-тировый вывод совпадает с боевой панелью байт-в-байт (golden-diff). ---
  const balancers: Array<Record<string, unknown>> = [];
  if (!singleChannel) {
    tiers.forEach((tier, i) => {
      const last = i === tiers.length - 1;
      balancers.push({
        tag: `tier${i + 1}`,
        selector: tier.map((c) => c.tag),
        ...(last ? {} : { fallbackTag: `lo-out-${i + 1}` }),
        strategy: { type: last && tiers.length > 1 ? "random" : "leastPing" },
      });
    });
  }

  // --- routing rules ---
  const ruSplit = profile.ruSplit !== false;
  const { head } = buildSplitRoutingHead(input.domainList, ruSplit);
  const rules = [...head];
  // loopback-реинжект ДО catch-all: трафик, вернувшийся из эшелона k, уходит в k+1
  for (let k = 1; k <= hops; k++) {
    rules.push({ type: "field", inboundTag: [`lo-in-${k}`], balancerTag: `tier${k + 1}` });
  }
  rules.push(
    singleChannel
      ? { type: "field", network: "tcp,udp", outboundTag: singleChannel.tag }
      : { type: "field", network: "tcp,udp", balancerTag: "tier1" },
  );

  const config: XrayConfig = {
    log: { loglevel: "warning" },
    dns: buildDns(input.domainList, ruSplit),
    inbounds,
    outbounds,
    routing: { domainStrategy: "AsIs", balancers, rules },
  };

  // Observatory нужна только балансерам: без них измерять нечего, а пробы
  // впустую гоняли бы трафик через единственный канал.
  if (balancers.length > 0) {
    config.observatory = {
      subjectSelector: uniq(balancers.flatMap((b) => b.selector as string[])),
      probeUrl: input.probeUrl ?? DEFAULT_PROBE_URL,
      probeInterval: input.probeInterval ?? DEFAULT_PROBE_INTERVAL,
    };
  }

  return config;
}

/** Профиль «Авто»: все direct в primary, все cascade в fallback. Эквивалент базового Remnawave-вывода. */
export function autoProfile(input: GeneratorInput): ProfileInput {
  return {
    remark: "🔀 Авто",
    isAuto: true,
    primary: input.channels.filter((c) => c.kind === "direct").map((c) => c.tag),
    fallback: input.channels.filter((c) => c.kind === "cascade").map((c) => c.tag),
  };
}

/** База = конфиг профиля «Авто» со всеми каналами. Против него идёт golden byte-diff (спайк 1). */
export function assembleBase(input: GeneratorInput): XrayConfig {
  return buildProfileConfig(input, autoProfile(input));
}

/** VARIANTS-проекция: массив полных конфигов по профилям (формат мульти-профильной подписки Happ). */
export function projectVariants(input: GeneratorInput, profiles: ProfileInput[]): RenderedProfile[] {
  return profiles.map((p) => ({ remark: p.remark, config: buildProfileConfig(input, p) }));
}

function must<T>(map: Map<string, T>, key: string): T {
  const v = map.get(key);
  if (v === undefined) throw new Error(`channel not found: ${key}`);
  return v;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
