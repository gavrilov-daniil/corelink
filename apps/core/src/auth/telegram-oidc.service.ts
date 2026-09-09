import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { schema, type Database } from "@corelink/db";
import { decryptSecret, encryptSecret, isEncrypted, request } from "@corelink/core-kit";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { OidcStore } from "./oidc-store.js";

/** Провайдер: значения из https://oauth.telegram.org/.well-known/openid-configuration. */
const ISSUER = "https://oauth.telegram.org";
const AUTHORIZATION_ENDPOINT = `${ISSUER}/auth`;
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URL = new URL(`${ISSUER}/.well-known/jwks.json`);

/**
 * `id` (телеграмный user id) отдаётся только со scope `profile`; `openid` даёт
 * лишь `sub` — непрозрачный идентификатор, по которому бота с оператором не связать.
 * Телефон не запрашиваем: для входа он не нужен, а хранить его — лишний риск.
 */
const SCOPE = "openid profile";

/** Время на прохождение экрана Telegram. Дольше — украденная ссылка дольше остаётся ключом. */
const STATE_TTL_SEC = 600;
/** Билет живёт ровно столько, сколько нужно админке, чтобы обменять его сразу после редиректа. */
const TICKET_TTL_SEC = 60;
/** Расхождение часов сервера и Telegram: без допуска свежий токен иногда «из будущего». */
const CLOCK_TOLERANCE_SEC = 30;

export type LoginIntent = "login" | "link";

export interface TelegramIdentity {
  telegramId: number;
  username: string | null;
  displayName: string | null;
}

interface StateData {
  codeVerifier: string;
  binderHash: string;
  intent: LoginIntent;
  operatorId?: string;
}

export interface StartedLogin {
  url: string;
  /** Кладётся в httpOnly-куку: связывает начатый вход именно с этим браузером. */
  binder: string;
  /** Origin нашего callback'а: по нему решается, ставить ли куке флаг Secure. */
  origin: string;
}

export interface FinishedLogin {
  identity: TelegramIdentity;
  intent: LoginIntent;
  operatorId?: string;
}

const jwks = createRemoteJWKSet(JWKS_URL);

/**
 * Вход по Telegram через Web Login (OpenID Connect, authorization code + PKCE).
 *
 * Отличие от прежнего Login Widget, ради которого сделан переезд: ключ проверки
 * входа больше не совпадает с токеном бота. `client_secret` отзывается в BotFather
 * отдельно и не даёт доступа к Bot API, поэтому утечка настроек админки больше не
 * означает возможность писать всей клиентской базе. Второе следствие — Allowed URLs
 * в BotFather это список, так что один бот обслуживает и админку, и другие домены.
 *
 * Секрет лежит зашифрованным (AES-256-GCM на SECRETS_MASTER_KEY, тот же механизм,
 * что у кредов мерчантов), наружу отдаётся только признак «задан».
 */
@Injectable()
export class TelegramOidcService {
  private readonly log = new Logger(TelegramOidcService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly store: OidcStore,
  ) {}

  private async row() {
    const [row] = await this.db
      .select()
      .from(schema.telegramAuthSetting)
      .where(eq(schema.telegramAuthSetting.orgId, this.cfg.defaultOrgId))
      .limit(1);
    return row ?? null;
  }

  /** Публичная часть: по ней страница входа решает, показывать ли кнопку Telegram. */
  async publicConfig(): Promise<{ enabled: boolean }> {
    const row = await this.row();
    return { enabled: isUsable(row) };
  }

  async settingsForAdmin() {
    return forAdmin(await this.row());
  }

  /**
   * Правка настроек. `clientSecret` не передан — не трогаем; пустая строка — стираем.
   * Ровно как у кредов мерчантов: иначе замаскированное значение из формы затирало бы секрет.
   */
  async updateSettings(input: {
    isEnabled?: boolean;
    botUsername?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  }) {
    const current = await this.row();

    const botUsername = normalizeUsername(input.botUsername ?? current?.botUsername ?? "");
    const clientId = (input.clientId ?? current?.clientId ?? "").trim();
    const redirectUri = (input.redirectUri ?? current?.redirectUri ?? "").trim();
    const isEnabled = input.isEnabled ?? current?.isEnabled ?? false;
    let clientSecret = current?.clientSecret ?? "";
    if (input.clientSecret !== undefined) {
      const raw = input.clientSecret.trim();
      clientSecret = raw === "" ? "" : encryptSecret(raw, this.cfg.secretsMasterKey);
    }

    if (redirectUri && !isHttpsUrl(redirectUri)) {
      throw new BadRequestException("redirect_uri должен быть полным https-адресом");
    }

    if (isEnabled && (!clientId || !clientSecret || !redirectUri)) {
      throw new BadRequestException("для включения входа нужны client_id, client_secret и redirect_uri");
    }

    const updatedAt = new Date();
    if (current) {
      await this.db
        .update(schema.telegramAuthSetting)
        .set({ isEnabled, botUsername, clientId, clientSecret, redirectUri, updatedAt })
        .where(eq(schema.telegramAuthSetting.id, current.id));
    } else {
      await this.db.insert(schema.telegramAuthSetting).values({
        orgId: this.cfg.defaultOrgId,
        isEnabled,
        botUsername,
        clientId,
        clientSecret,
        redirectUri,
        updatedAt,
      });
    }

    return forAdmin({ isEnabled, botUsername, clientId, clientSecret, redirectUri, updatedAt });
  }

  /**
   * Начало входа: ссылка на экран Telegram и связующее значение для куки.
   *
   * PKCE обязателен, хотя секрет у нас есть: перехваченный код без верификатора
   * ничего не даёт, а верификатор не покидает сервер.
   */
  async start(input: { intent: LoginIntent; operatorId?: string }): Promise<StartedLogin> {
    const row = await this.row();
    if (!isUsable(row)) throw new BadRequestException("вход по Telegram выключен");

    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const binder = randomBytes(32).toString("base64url");

    const data: StateData = {
      codeVerifier,
      binderHash: sha256(binder),
      intent: input.intent,
      ...(input.operatorId ? { operatorId: input.operatorId } : {}),
    };
    await this.store.put(stateKey(state), data, STATE_TTL_SEC);

    const params = new URLSearchParams({
      client_id: row!.clientId,
      redirect_uri: row!.redirectUri,
      response_type: "code",
      scope: SCOPE,
      state,
      code_challenge: base64url(createHash("sha256").update(codeVerifier).digest()),
      code_challenge_method: "S256",
    });

    return { url: `${AUTHORIZATION_ENDPOINT}?${params.toString()}`, binder, origin: originOf(row!.redirectUri) };
  }

  /**
   * Куда возвращать браузер после callback'а. Берём origin из redirect_uri, а не
   * из отдельной настройки: это тот же домен админки, и лишнее поле рассинхронизируется.
   */
  async appOrigin(): Promise<string> {
    const row = await this.row();
    return originOf(row?.redirectUri ?? "");
  }

  /**
   * Возврат от Telegram: меняем код на токены и проверяем подпись id_token.
   *
   * Всё, что не сошлось, — одинаково неинформативная ошибка: подсказывать
   * перебирающему, какая именно проверка не прошла, незачем.
   */
  async finish(input: { code: string; state: string; binder: string }): Promise<FinishedLogin> {
    const row = await this.row();
    if (!isUsable(row)) throw new BadRequestException("вход по Telegram выключен");

    const data = await this.store.take<StateData>(stateKey(input.state));
    if (!data) throw new BadRequestException("сессия входа устарела, попробуйте ещё раз");

    // Кука привязывает начатый вход к браузеру: без неё чужой код, подсунутый
    // жертве ссылкой, залогинил бы её под аккаунтом атакующего.
    if (!input.binder || !constantTimeEqual(sha256(input.binder), data.binderHash)) {
      this.log.warn("вход по Telegram отклонён: state не принадлежит этому браузеру");
      throw new BadRequestException("сессия входа не подтверждена, попробуйте ещё раз");
    }

    const clientSecret = this.readSecret(row!.clientSecret);
    const idToken = await this.exchangeCode({
      code: input.code,
      clientId: row!.clientId,
      clientSecret,
      redirectUri: row!.redirectUri,
      codeVerifier: data.codeVerifier,
    });

    const identity = await this.verifyIdToken(idToken, row!.clientId);
    return { identity, intent: data.intent, ...(data.operatorId ? { operatorId: data.operatorId } : {}) };
  }

  /** Билет вместо токена сессии в адресной строке: он одноразовый и живёт минуту. */
  async issueTicket(payload: unknown): Promise<string> {
    const ticket = randomBytes(32).toString("base64url");
    await this.store.put(ticketKey(ticket), payload, TICKET_TTL_SEC);
    return ticket;
  }

  async takeTicket<T>(ticket: string): Promise<T | null> {
    if (!ticket) return null;
    return this.store.take<T>(ticketKey(ticket));
  }

  private readSecret(stored: string): string {
    try {
      return isEncrypted(stored) ? decryptSecret(stored, this.cfg.secretsMasterKey) : stored;
    } catch {
      // Сменили SECRETS_MASTER_KEY или подняли дамп со старым ключом: секрет нечитаем.
      this.log.error("client_secret не расшифровывается — вход по Telegram нерабочий, введите секрет заново");
      throw new BadRequestException("вход по Telegram не настроен");
    }
  }

  private async exchangeCode(input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string> {
    const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");

    const res = await request<{ id_token?: string; error?: string; error_description?: string }>(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Basic ${basic}` },
      form: {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        code_verifier: input.codeVerifier,
      },
      provider: "telegram-oidc",
      timeoutMs: 8_000,
      // Код одноразовый: повтор после успешного обмена вернёт ошибку, а не второй токен.
      retries: 0,
    });

    const idToken = res.body?.id_token;
    if (!idToken) {
      this.log.warn(`Telegram не отдал id_token: ${res.body?.error ?? "нет поля"}`);
      throw new BadRequestException("Telegram не подтвердил вход");
    }
    return idToken;
  }

  private async verifyIdToken(idToken: string, clientId: string): Promise<TelegramIdentity> {
    let claims: Record<string, unknown>;
    try {
      const verified = await jwtVerify(idToken, jwks, {
        issuer: ISSUER,
        audience: clientId,
        clockTolerance: CLOCK_TOLERANCE_SEC,
      });
      claims = verified.payload as Record<string, unknown>;
    } catch (err) {
      this.log.warn(`id_token не прошёл проверку: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadRequestException("Telegram не подтвердил вход");
    }

    // sub — непрозрачный идентификатор пары «бот + пользователь», к telegram_id
    // отношения не имеет. Связь с ботом и подписками держится на id из scope profile.
    const telegramId = Number(claims.id);
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
      this.log.warn("в id_token нет telegram id — вероятно, не выдан scope profile");
      throw new BadRequestException("Telegram не передал идентификатор пользователя");
    }

    const username = typeof claims.preferred_username === "string" ? claims.preferred_username.replace(/^@/, "") : "";
    const name = typeof claims.name === "string" ? claims.name.trim() : "";

    return { telegramId, username: username || null, displayName: name || null };
  }
}

function isUsable(row: { isEnabled: boolean; clientId: string; clientSecret: string; redirectUri: string } | null) {
  return Boolean(row?.isEnabled && row.clientId && row.clientSecret && row.redirectUri);
}

/** Проекция настроек наружу: секрет не отдаём никогда, только факт его наличия. */
function forAdmin(
  row: {
    isEnabled: boolean;
    botUsername: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    updatedAt: Date;
  } | null,
) {
  return {
    isEnabled: row?.isEnabled ?? false,
    botUsername: row?.botUsername ?? "",
    clientId: row?.clientId ?? "",
    redirectUri: row?.redirectUri ?? "",
    hasClientSecret: Boolean(row?.clientSecret),
    updatedAt: row?.updatedAt ?? null,
  };
}

function stateKey(state: string): string {
  return `oidc:state:${state}`;
}

function ticketKey(ticket: string): string {
  return `oidc:ticket:${ticket}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // localhost по http — единственное послабление: без него не отладить вход локально.
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "");
}
