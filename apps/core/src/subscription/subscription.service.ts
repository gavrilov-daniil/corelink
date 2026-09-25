import { Injectable, Logger } from "@nestjs/common";
import { projectVariants, validateConfig, type XrayConfig } from "@corelink/xray-config";
import { loadConfig } from "../config.js";
import { BotClient } from "../bot/bot.client.js";
import { RateLimitService } from "../common/rate-limit.service.js";
import { isDeviceWithinLimit } from "./device-limit.js";
import { SubscriptionRepository } from "./subscription.repository.js";

export interface DeliveryResult {
  kind: "happ" | "stub" | "error" | "throttled";
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** Всё, что выдача знает о запросе: адрес для лимита и то, что клиент рассказал о себе. */
export interface DeliveryRequest {
  ip: string;
  userAgent: string;
  hwid?: string;
  deviceOs?: string;
  osVer?: string;
  deviceModel?: string;
}

type FoundSubscription = NonNullable<Awaited<ReturnType<SubscriptionRepository["findByShortUuid"]>>>;

// Happ ждёт полный текст подписки только на своём UA. Иначе — заглушка тем же форматом (не пустой ответ).
const HAPP_UA = /happ/i;

const ALERT_THROTTLE_MS = 60 * 60_000;

/** Ограничители длины на то, что пришло из заголовков клиента: в БД мусор не кладём. */
const HWID_MAX = 128;
const DEVICE_FIELD_MAX = 64;

@Injectable()
export class SubscriptionService {
  private readonly log = new Logger(SubscriptionService.name);
  private readonly cfg = loadConfig();
  private lastAlertAt = 0;

  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly bot: BotClient,
    private readonly limiter: RateLimitService,
  ) {}

  async deliverByShortUuid(shortUuid: string, req: DeliveryRequest): Promise<DeliveryResult> {
    const throttled = await this.throttle(req.ip, shortUuid);
    if (throttled) return throttled;

    const sub = await this.repo.findByShortUuid(this.cfg.defaultOrgId, shortUuid);
    return this.deliver(sub, req);
  }

  async deliverById(id: string, req: DeliveryRequest): Promise<DeliveryResult> {
    const throttled = await this.throttle(req.ip, id);
    if (throttled) return throttled;

    const sub = await this.repo.findById(this.cfg.defaultOrgId, id);
    return this.deliver(sub, req);
  }

  /**
   * Лимиты считаются ДО похода в БД и по идентификатору из URL, а не по найденной
   * подписке: перебор short_uuid не должен стоить нам ни одного запроса к базе.
   */
  private async throttle(ip: string, subKey: string): Promise<DeliveryResult | null> {
    const byIp = await this.limiter.check(`sub:ip:${ip}`, this.cfg.subRateLimitPerIp);
    if (!byIp.allowed) return this.tooManyRequests(byIp.retryAfterSec, `ip ${ip}`);

    const bySub = await this.limiter.check(`sub:key:${subKey}`, this.cfg.subRateLimitPerSub);
    if (!bySub.allowed) return this.tooManyRequests(bySub.retryAfterSec, `подписка ${subKey}`);

    return null;
  }

  private async deliver(sub: FoundSubscription | null, req: DeliveryRequest): Promise<DeliveryResult> {
    // защита эндпоинта: только Happ (несущий барьер — не единственный, см. docs/architecture.md)
    if (!HAPP_UA.test(req.userAgent)) return this.stub("Откройте подписку в приложении Happ.");
    if (!sub) return this.stub("Подписка не найдена.");

    const denial = accessDenial(sub);
    if (denial) return this.stub(denial);

    await this.markVisit(sub, req.userAgent);

    const overLimit = await this.enforceDeviceLimit(sub, req);
    if (overLimit) return overLimit;

    try {
      const bundle = await this.repo.loadBundle(this.cfg.defaultOrgId, sub);
      if (!bundle) return this.failure(sub.shortUuid, "каналы или профили не собрались (выдача или доступ по squad'ам)");

      const rendered = projectVariants(bundle.input, bundle.profiles);

      // инвариант-валидатор: не публикуем сломанный конфиг (молчаливый отвал failover)
      for (const r of rendered) {
        const res = validateConfig(r.config);
        if (!res.ok) return this.failure(sub.shortUuid, `инвариант конфига [${r.remark}]: ${res.errors.join("; ")}`);
      }

      // формат Happ: JSON-массив полных конфигов, remarks = имя профиля
      const configs: XrayConfig[] = rendered.map((r) => ({ ...r.config, remarks: r.remark }));
      return {
        kind: "happ",
        status: 200,
        body: JSON.stringify(configs),
        headers: this.happHeaders(sub),
      };
    } catch (err) {
      return this.failure(sub.shortUuid, err instanceof Error ? err.message : String(err));
    }
  }

  /** Отметка «клиент приходил». Сбой записи не имеет права отнять конфиг у клиента. */
  private async markVisit(sub: FoundSubscription, userAgent: string): Promise<void> {
    try {
      await this.repo.markVisit(sub.id, userAgent);
    } catch (err) {
      this.log.warn(`подписка ${sub.shortUuid}: отметка посещения не записалась — ${message(err)}`);
    }
  }

  /**
   * HWID device-limit.
   *
   * Клиент без `x-hwid` НЕ получает отказ, даже когда лимит включён: часть клиентов
   * заголовок не шлёт вовсе, и отказ здесь ломал живых пользователей в проде
   * (боль Remnawave). Такое устройство считается неизвестным и слот не занимает.
   *
   * Сбой учёта устройств тоже не отнимает доступ — лимит устройств не тот рубеж,
   * ради которого стоит оставлять оплатившего клиента без VPN.
   */
  private async enforceDeviceLimit(sub: FoundSubscription, req: DeliveryRequest): Promise<DeliveryResult | null> {
    const limit = sub.hwidDeviceLimit ?? 0;
    const hwid = clip(req.hwid, HWID_MAX);

    if (!hwid) {
      if (limit > 0) {
        this.log.warn(`подписка ${sub.shortUuid}: лимит ${limit} устройств, клиент не прислал x-hwid — пропускаем`);
      }
      return null;
    }

    try {
      await this.repo.touchDevice(sub.orgId, sub.id, {
        hwid,
        deviceOs: clip(req.deviceOs, DEVICE_FIELD_MAX),
        osVer: clip(req.osVer, DEVICE_FIELD_MAX),
        deviceModel: clip(req.deviceModel, DEVICE_FIELD_MAX),
        userAgent: clip(req.userAgent, DEVICE_FIELD_MAX * 4),
      });
      if (limit <= 0) return null;

      const since = new Date(Date.now() - this.cfg.hwidActiveWindowDays * 86_400_000);
      const active = await this.repo.activeDeviceHwids(sub.id, since);
      if (isDeviceWithinLimit(active, limit, hwid)) return null;

      this.log.warn(`подписка ${sub.shortUuid}: устройство ${hwid.slice(0, 16)} сверх лимита ${limit}`);
      return this.stub(`Превышен лимит устройств: ${limit}. Отвяжите лишнее устройство в боте.`);
    } catch (err) {
      this.log.warn(`подписка ${sub.shortUuid}: учёт устройства не сработал — ${message(err)}`);
      return null;
    }
  }

  /**
   * Перебор или расшаренная в чат ссылка. Тела подписки в ответе нет.
   * 429 клиенту безопасен: на не-2xx Happ держит прошлый рабочий конфиг и приходит
   * снова — легальный клиент вернётся к нормальной выдаче, как только окно освободится.
   */
  private tooManyRequests(retryAfterSec: number, subject: string): DeliveryResult {
    this.log.warn(`лимит выдачи подписки: ${subject}, retry-after ${retryAfterSec}s`);
    return {
      kind: "throttled",
      status: 429,
      body: JSON.stringify({ error: "rate_limited" }),
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(retryAfterSec),
      },
    };
  }

  private happHeaders(sub: FoundSubscription): Record<string, string> {
    const total = sub.trafficLimitBytes ?? 0;
    const download = sub.usedTrafficBytes ?? 0;
    const expire = sub.expireAt ? Math.floor(new Date(sub.expireAt).getTime() / 1000) : 0;
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      // байт-в-байт совместимо с тем, что ждут мигрированные Happ (migration.md P0-2)
      "subscription-userinfo": `upload=0; download=${download}; total=${total}; expire=${expire}`,
      "profile-update-interval": String(this.cfg.profileUpdateIntervalHours),
      // Заголовки с человеческим текстом кодируются base64 с префиксом: в HTTP-заголовке
      // не может быть кириллицы, а название и объявление у нас на русском.
      // Формат сверен с боевой выдачей действующей панели (спайк golden-diff).
      "profile-title": encodeHeaderText(this.cfg.profileTitle),
    };
    if (this.cfg.supportUrl) headers["support-url"] = this.cfg.supportUrl;
    if (this.cfg.announce) headers["announce"] = encodeHeaderText(this.cfg.announce);
    return headers;
  }

  /**
   * Штатное пользовательское состояние: подписки нет, истекла, приостановлена, зашли не из Happ.
   * Только здесь допустим 200 с заглушкой — клиент осознанно заменяет конфиг на сообщение.
   *
   * Заглушка обязана быть НЕРАБОТОСПОСОБНЫМ профилем. В списке Happ она выглядит как
   * обычный профиль, и человек по ней жмёт «Подключить»: с freedom-outbound он получал
   * бы «Connected» и весь трафик НАПРЯМУЮ, будучи уверенным, что сидит под VPN. Для
   * аудитории в РФ это худший возможный исход, хуже честной ошибки подключения.
   * Поэтому единственный outbound — blackhole, и catch-all уводит в него весь трафик.
   * Причину человек читает в remarks — заглушка нужна ровно для этого.
   */
  private stub(message: string): DeliveryResult {
    const body = JSON.stringify([
      {
        remarks: message,
        outbounds: [{ tag: "block", protocol: "blackhole" }],
        routing: { rules: [{ type: "field", network: "tcp,udp", outboundTag: "block" }] },
      },
    ]);
    return { kind: "stub", status: 200, body, headers: { "content-type": "application/json; charset=utf-8" } };
  }

  /**
   * Наша поломка (битые данные, не собрались профили, исключение генератора) — 503, НЕ заглушка.
   * На 5xx Happ оставляет прошлый рабочий конфиг; 200 с заглушкой он принял бы за новую подписку
   * и на плановом обновлении стёр бы рабочие каналы у всей базы разом.
   */
  private failure(shortUuid: string, reason: string): DeliveryResult {
    this.log.error(`подписка ${shortUuid}: сборка не удалась — ${reason}`);
    void this.alertBuildFailure(reason);
    return {
      kind: "error",
      status: 503,
      body: JSON.stringify({ error: "subscription_build_failed" }),
      headers: { "content-type": "application/json; charset=utf-8", "retry-after": "300" },
    };
  }

  /**
   * Троттл in-memory, а не через job_dedup: поломка сборки видна на каждом запросе клиента,
   * и поход в БД ради дедупа добавил бы ещё одну точку отказа на уже сломанном пути.
   * Цена — при N инстансах api до N алертов в час; дубль алерта дешевле пропущенного.
   * Слот занимаем ДО отправки, иначе параллельные запросы проскочат все разом.
   */
  private async alertBuildFailure(reason: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastAlertAt < ALERT_THROTTLE_MS) return;
    this.lastAlertAt = now;
    await this.bot.alert(`🚨 Подписка не собирается, клиентам уходит 503\n<code>${reason.slice(0, 300)}</code>`);
  }
}

/** Статусы, которым тело подписки положено. Всё остальное — заглушка. */
const ACCESS_STATUSES = new Set(["active", "trial"]);

/**
 * Гейт доступа к телу подписки — allowlist, а не список запрещённых статусов.
 *
 * В теле лежит карта сети: address/port/sni/pbk/sid ВСЕХ каналов и front-хоста.
 * На blocklist'е (`disabled|suspended`) её получал любой, кто когда-то нажал /start:
 * `inactive` (статус при создании подписки) и `expired` (его ставит джоба) проходили
 * дальше. Доступа на нодах у них нет, но инвентарь сети для DPI утекал.
 * Поэтому новый статус обязан быть добавлен сюда явно, а не получить доступ по умолчанию.
 *
 * Срок проверяется здесь же, а не только джобой: между истечением и её прогоном
 * статус ещё `active`, и подписка успела бы отдать конфиг.
 */
function accessDenial(sub: FoundSubscription): string | null {
  if (sub.status === "disabled" || sub.status === "suspended") return "Подписка приостановлена.";
  if (sub.status === "expired") return "Подписка истекла, продлите её в боте.";
  if (!ACCESS_STATUSES.has(sub.status)) return "Подписка не активна — оформите доступ в боте.";
  // expire_at IS NULL = бессрочная (ручная выдача, служебные подписки)
  if (sub.expireAt && new Date(sub.expireAt).getTime() <= Date.now()) {
    return "Подписка истекла, продлите её в боте.";
  }
  return null;
}

function clip(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Текстовые заголовки подписки клиент ждёт в base64 с префиксом `base64:`.
 * ASCII-строки отдаём как есть — так делает действующая панель, и лишнее
 * кодирование ломало бы сравнение при миграции.
 */
function encodeHeaderText(value: string): string {
  if (!value) return value;
  // eslint-disable-next-line no-control-regex
  const isAscii = /^[\x20-\x7E]*$/.test(value);
  return isAscii ? value : `base64:${Buffer.from(value, "utf8").toString("base64")}`;
}
