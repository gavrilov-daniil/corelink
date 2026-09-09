import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, count, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { isAdminRole, roleAtLeast, type AdminRole, type OperatorContext } from "./roles.js";
import type { TelegramIdentity } from "./telegram-oidc.service.js";

const scrypt = promisify(scryptCb);

/** Срок жизни сессии. Короче — оператор злится, длиннее — украденный токен живёт дольше. */
const SESSION_TTL_MS = 7 * 24 * 3600_000;

/** Ниже этого пароль подбирается быстрее, чем оператор успевает его сменить. */
const MIN_PASSWORD_LENGTH = 10;

interface OperatorSession {
  token: string;
  expiresAt: Date;
  operator: { id: string; email: string | null; role: AdminRole; displayName: string | null };
}

/** Заявка сессии не даёт, поэтому размеченное объединение, а не набор опциональных полей. */
export type TelegramLoginResult = { status: "pending" } | ({ status: "ok" } & OperatorSession);

/**
 * Учётки операторов админки.
 *
 * Пароли — scrypt со случайной солью: он memory-hard, поэтому перебор дампа
 * дороже, чем при sha256/pbkdf2. Внешних зависимостей (argon2/bcrypt) не тянем:
 * scrypt есть в стандартной библиотеке Node.
 *
 * В браузере живёт только случайный токен сессии, в БД — его хеш.
 *
 * Два входа на одну учётку: email+пароль и Telegram. Учётку с почтой заводит только
 * админ из админки; через Telegram человек может лишь оставить заявку (`status=pending`),
 * которая до подтверждения не даёт ни сессии, ни единого экрана.
 */
@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
  }

  async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [algo, saltB64, hashB64] = stored.split("$");
    if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, "base64");
    const derived = (await scrypt(password, Buffer.from(saltB64, "base64"), expected.length)) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  // --- вход ------------------------------------------------------------------

  /**
   * Вход по email и паролю. Ответ одинаков и при неизвестном email, и при неверном
   * пароле — иначе форма входа превращается в список существующих операторов.
   */
  async login(input: { email: string; password: string; userAgent?: string; ip?: string }) {
    const [operator] = await this.db
      .select()
      .from(schema.user)
      .where(
        and(
          eq(schema.user.orgId, this.cfg.defaultOrgId),
          eq(schema.user.email, input.email.toLowerCase().trim()),
          eq(schema.user.status, "active"),
        ),
      )
      .limit(1);

    const ok = operator?.passwordHash ? await this.verifyPassword(input.password, operator.passwordHash) : false;
    if (!ok || !operator) {
      this.log.warn(`неудачный вход: ${input.email}`);
      throw new UnauthorizedException("неверный email или пароль");
    }

    const session = await this.issueSession(operator.id, input);
    return {
      ...session,
      operator: {
        id: operator.id,
        email: operator.email,
        role: operator.role as AdminRole,
        displayName: operator.displayName,
      },
    };
  }

  /**
   * Вход по Telegram. Незнакомый telegram_id не отвергается, а заводит заявку:
   * строка со `status=pending`, без сессии и с минимальной ролью. Пока админ не
   * подтвердил её, ответ один и тот же — «ждите подтверждения», и ни один экран
   * админки такому человеку не открывается.
   */
  async loginWithTelegram(input: {
    identity: TelegramIdentity;
    userAgent?: string;
    ip?: string;
  }): Promise<TelegramLoginResult> {
    const { identity } = input;

    const existing = await this.findByTelegramId(identity.telegramId);
    if (!existing) {
      // Гонка двух вкладок ловится уникальным индексом, а не проверкой выше.
      await this.db
        .insert(schema.user)
        .values({
          orgId: this.cfg.defaultOrgId,
          telegramId: identity.telegramId,
          telegramUsername: identity.username,
          displayName: identity.displayName,
          role: "support",
          status: "pending",
        })
        .onConflictDoNothing();
      this.log.warn(`заявка на доступ из Telegram: ${identity.username ?? identity.telegramId}`);
      return { status: "pending" };
    }

    if (existing.status === "disabled") throw new ForbiddenException("доступ отключён");

    // Имя и @username в Telegram меняются; подтверждающему админу нужны свежие.
    if (existing.telegramUsername !== identity.username || existing.displayName !== identity.displayName) {
      await this.db
        .update(schema.user)
        .set({ telegramUsername: identity.username, displayName: identity.displayName ?? existing.displayName })
        .where(eq(schema.user.id, existing.id));
    }

    if (existing.status !== "active") return { status: "pending" };

    const session = await this.issueSession(existing.id, input);
    return {
      status: "ok",
      ...session,
      operator: {
        id: existing.id,
        email: existing.email,
        role: existing.role as AdminRole,
        displayName: identity.displayName ?? existing.displayName,
      },
    };
  }

  private async issueSession(userId: string, input: { userAgent?: string; ip?: string }) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.insert(schema.operatorSession).values({
      orgId: this.cfg.defaultOrgId,
      userId,
      tokenHash: hashToken(token),
      userAgent: input.userAgent?.slice(0, 300),
      ip: input.ip,
      expiresAt,
      lastSeenAt: new Date(),
    });
    return { token, expiresAt };
  }

  /** Проверка сессии на каждом админском запросе. */
  async resolveSession(token: string) {
    const [row] = await this.db
      .select({ session: schema.operatorSession, operator: schema.user })
      .from(schema.operatorSession)
      .innerJoin(schema.user, eq(schema.operatorSession.userId, schema.user.id))
      .where(
        and(
          eq(schema.operatorSession.tokenHash, hashToken(token)),
          isNull(schema.operatorSession.revokedAt),
          gt(schema.operatorSession.expiresAt, new Date()),
          eq(schema.user.status, "active"),
        ),
      )
      .limit(1);

    if (!row) return null;

    // отметка активности раз в минуту, а не на каждый запрос — иначе лишняя запись на каждый клик
    const lastSeen = row.session.lastSeenAt?.getTime() ?? 0;
    if (Date.now() - lastSeen > 60_000) {
      await this.db
        .update(schema.operatorSession)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.operatorSession.id, row.session.id));
    }

    return {
      operatorId: row.operator.id,
      email: row.operator.email,
      role: row.operator.role as AdminRole,
      displayName: row.operator.displayName,
      telegramUsername: row.operator.telegramUsername,
      hasPassword: Boolean(row.operator.passwordHash),
      hasTelegram: row.operator.telegramId !== null,
    };
  }

  async logout(token: string) {
    await this.db
      .update(schema.operatorSession)
      .set({ revokedAt: new Date() })
      .where(eq(schema.operatorSession.tokenHash, hashToken(token)));
    return { ok: true };
  }

  // --- управление учётками ---------------------------------------------------

  async listOperators() {
    return this.db
      .select({
        id: schema.user.id,
        email: schema.user.email,
        displayName: schema.user.displayName,
        telegramId: schema.user.telegramId,
        telegramUsername: schema.user.telegramUsername,
        role: schema.user.role,
        status: schema.user.status,
        hasPassword: sql<boolean>`${schema.user.passwordHash} is not null`,
        approvedAt: schema.user.approvedAt,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .where(eq(schema.user.orgId, this.cfg.defaultOrgId))
      .orderBy(schema.user.createdAt);
  }

  /**
   * Заведение учётки с почтой и паролем. Только отсюда: самозаписи по email нет,
   * а через Telegram человек попадает лишь в заявки.
   */
  async createOperator(
    input: { email: string; password: string; role?: string; displayName?: string },
    actor: OperatorContext,
  ) {
    const email = (input.email ?? "").toLowerCase().trim();
    if (!email.includes("@")) throw new BadRequestException("нужен корректный email");
    this.assertPassword(input.password);
    const role = this.assertAssignableRole(input.role ?? "support", actor);

    const [row] = await this.db
      .insert(schema.user)
      .values({
        orgId: this.cfg.defaultOrgId,
        email,
        passwordHash: await this.hashPassword(input.password),
        displayName: input.displayName?.trim() || null,
        role,
        status: "active",
        approvedAt: new Date(),
        approvedByUserId: actor.operatorId,
      })
      .onConflictDoNothing()
      .returning({ id: schema.user.id, email: schema.user.email, role: schema.user.role });

    if (!row) throw new BadRequestException("учётка с таким email уже есть");
    this.log.warn(`заведена учётка ${email} с ролью ${role} (кем: ${actorName(actor)})`);
    return row;
  }

  /** Подтверждение заявки из Telegram: даём роль и включаем доступ. */
  async approveOperator(userId: string, role: string, actor: OperatorContext) {
    const target = await this.requireUser(userId);
    if (target.status !== "pending") throw new BadRequestException("заявка уже обработана");
    const assigned = this.assertAssignableRole(role, actor);

    await this.db
      .update(schema.user)
      .set({ role: assigned, status: "active", approvedAt: new Date(), approvedByUserId: actor.operatorId })
      .where(eq(schema.user.id, userId));

    this.log.warn(`доступ подтверждён: ${describe(target)} → ${assigned} (кем: ${actorName(actor)})`);
    return { ok: true };
  }

  /**
   * Правка чужой учётки: роль и/или доступ. Роль и статус меняются одной записью —
   * иначе смена роли успевала примениться, а следом «последний superadmin» отменял
   * отключение, и учётка оставалась в состоянии, которого никто не просил.
   */
  async updateOperator(
    userId: string,
    patch: { role?: string; status?: "active" | "disabled" },
    actor: OperatorContext,
  ) {
    const target = await this.requireUser(userId);
    this.assertCanManage(target, actor);

    const role = patch.role === undefined ? (target.role as AdminRole) : this.assertAssignableRole(patch.role, actor);
    const status = patch.status ?? (target.status as "active" | "disabled" | "pending");
    if (status === "active" && target.status === "pending") {
      throw new BadRequestException("заявку нужно подтвердить с выбором роли");
    }
    if (role === target.role && status === target.status) return { ok: true };

    const losesSuperadmin =
      target.role === "superadmin" && target.status === "active" && (role !== "superadmin" || status !== "active");
    if (losesSuperadmin) await this.assertNotLastSuperadmin(userId);

    await this.db
      .update(schema.user)
      .set({ role, status })
      .where(and(eq(schema.user.orgId, this.cfg.defaultOrgId), eq(schema.user.id, userId)));

    // Роль читается из БД на каждом запросе, но понижение должно быть заметно сразу:
    // рубим сессии, чтобы человек перезашёл уже с новым набором экранов.
    if (role !== target.role || status === "disabled") await this.revokeSessions(userId);

    this.log.warn(
      `учётка ${describe(target)}: ${target.role}/${target.status} → ${role}/${status} (кем: ${actorName(actor)})`,
    );
    return { ok: true };
  }

  async changePassword(userId: string, newPassword: string, actor: OperatorContext) {
    const target = await this.requireUser(userId);
    if (target.id !== actor.operatorId) this.assertCanManage(target, actor);
    this.assertPassword(newPassword);
    if (!target.email) throw new BadRequestException("у учётки нет email — паролем она входить не может");

    await this.db
      .update(schema.user)
      .set({ passwordHash: await this.hashPassword(newPassword) })
      .where(and(eq(schema.user.orgId, this.cfg.defaultOrgId), eq(schema.user.id, userId)));
    // старые сессии рубим: смена пароля должна выкидывать чужие устройства
    await this.revokeSessions(userId);
    return { ok: true };
  }

  // --- привязка Telegram -----------------------------------------------------

  /** Привязка Telegram к своей учётке: владение подтверждается тем же виджетом, что и вход. */
  async linkTelegram(identity: TelegramIdentity, operatorId: string) {
    const owner = await this.findByTelegramId(identity.telegramId);
    if (owner && owner.id !== operatorId) {
      throw new BadRequestException("этот Telegram уже привязан к другой учётке");
    }

    await this.db
      .update(schema.user)
      .set({
        telegramId: identity.telegramId,
        telegramUsername: identity.username,
        displayName: identity.displayName,
      })
      .where(eq(schema.user.id, operatorId));

    return { telegramId: identity.telegramId, telegramUsername: identity.username };
  }

  /**
   * Отвязка. Учётка без пароля и без Telegram не войдёт уже никогда, поэтому
   * последний способ входа не отбираем — ни у себя, ни у чужой учётки.
   */
  async unlinkTelegram(userId: string, actor: OperatorContext) {
    const target = await this.requireUser(userId);
    if (target.id !== actor.operatorId) this.assertCanManage(target, actor);
    if (!target.telegramId) return { ok: true };
    if (!target.passwordHash) {
      throw new BadRequestException("это единственный способ входа: сначала заведите пароль");
    }

    await this.db
      .update(schema.user)
      .set({ telegramId: null, telegramUsername: null })
      .where(eq(schema.user.id, userId));
    return { ok: true };
  }

  // --- обслуживание ----------------------------------------------------------

  /** Чистка протухших сессий — вызывается джобой обслуживания. */
  async purgeExpired(): Promise<number> {
    const deleted = await this.db
      .delete(schema.operatorSession)
      .where(sql`${schema.operatorSession.expiresAt} < now() - interval '30 days'`)
      .returning({ id: schema.operatorSession.id });
    return deleted.length;
  }

  // --- внутреннее ------------------------------------------------------------

  private async findByTelegramId(telegramId: number) {
    const [row] = await this.db
      .select()
      .from(schema.user)
      .where(and(eq(schema.user.orgId, this.cfg.defaultOrgId), eq(schema.user.telegramId, telegramId)))
      .limit(1);
    return row ?? null;
  }

  private async requireUser(userId: string) {
    const [row] = await this.db
      .select()
      .from(schema.user)
      .where(and(eq(schema.user.orgId, this.cfg.defaultOrgId), eq(schema.user.id, userId)))
      .limit(1);
    if (!row) throw new NotFoundException("учётка не найдена");
    return row;
  }

  private async revokeSessions(userId: string) {
    await this.db
      .update(schema.operatorSession)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.operatorSession.userId, userId), isNull(schema.operatorSession.revokedAt)));
  }

  private assertPassword(password: string) {
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`пароль короче ${MIN_PASSWORD_LENGTH} символов`);
    }
  }

  /** Роль выше своей не выдаётся: иначе admin заводит себе superadmin'а и обходит запрет. */
  private assertAssignableRole(role: string, actor: OperatorContext): AdminRole {
    if (!isAdminRole(role)) throw new BadRequestException("неизвестная роль");
    if (!roleAtLeast(actor.role, role)) throw new ForbiddenException("нельзя выдать роль выше своей");
    return role;
  }

  /** Чужая учётка правится, только если её роль не выше собственной. Себя — не трогаем. */
  private assertCanManage(target: { id: string; role: string }, actor: OperatorContext) {
    if (target.id === actor.operatorId) {
      throw new ForbiddenException("свою учётку нельзя разжаловать или отключить");
    }
    if (!roleAtLeast(actor.role, target.role as AdminRole)) {
      throw new ForbiddenException("нельзя менять учётку с ролью выше своей");
    }
  }

  /**
   * Последний superadmin неприкосновенен: без него правка платёжных мерчантов
   * закрыта навсегда, а вернуть роль будет некому.
   */
  private async assertNotLastSuperadmin(userId: string) {
    const [row] = await this.db
      .select({ n: count() })
      .from(schema.user)
      .where(
        and(
          eq(schema.user.orgId, this.cfg.defaultOrgId),
          eq(schema.user.role, "superadmin"),
          eq(schema.user.status, "active"),
          ne(schema.user.id, userId),
        ),
      );
    if ((row?.n ?? 0) === 0) throw new BadRequestException("это последний superadmin — сначала назначьте другого");
  }
}

function describe(user: { id: string; email: string | null; telegramUsername: string | null }): string {
  return user.email ?? (user.telegramUsername ? `@${user.telegramUsername}` : user.id);
}

function actorName(actor: OperatorContext): string {
  return actor.viaSharedToken ? "ADMIN_TOKEN" : (actor.email ?? actor.operatorId ?? "?");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
