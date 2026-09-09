import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { loadConfig } from "../config.js";
import { ADMIN_PATH_PREFIX } from "./admin.guard.js";
import { clientIp } from "./client-ip.js";
import { isUnderPrefix, normalizedPath } from "./request-path.js";
import { RateLimitService, type RateLimitRule } from "./rate-limit.service.js";
import { INTERNAL_PATH_PREFIX } from "./service-token.guard.js";

export const WEBHOOK_PATH_PREFIX = "/webhooks";
export const ADMIN_LOGIN_PATH = "/api/admin/auth/login";
/**
 * Вход по Telegram — те же неаутентифицированные точки и тот же лимит, что у пароля.
 * `callback` и `exchange` здесь не для защиты пароля, а против перебора state и билета:
 * оба одноразовые, но угадывать их с одного IP тысячами попыток тоже не нужно.
 */
export const ADMIN_TELEGRAM_LOGIN_PATHS = [
  "/api/admin/auth/telegram/start",
  "/api/admin/auth/telegram/callback",
  "/api/admin/auth/telegram/exchange",
];

interface Check {
  key: string;
  rule: RateLimitRule;
  /** Что именно уткнулось в лимит — уходит в лог, клиенту не показывается. */
  subject: string;
}

/**
 * Барьер на непубличные разделы: админский API, вебхуки провайдеров, /internal/*.
 * Выдача подписки считается отдельно, внутри SubscriptionService (свои ключи и окна).
 *
 * Регистрируется ПЕРВЫМ из глобальных гвардов. Порядок здесь несущий: AdminGuard и
 * ServiceTokenGuard отвечают на неверный токен 401, и стоя после них лимитер не увидел
 * бы ни одной попытки перебора — ровно того трафика, ради которого он и заведён.
 *
 * Токены не участвуют в ключах: считать по IP значит не заводить счётчик на каждое
 * значение, которое перебирающий сам и придумывает.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly log = new Logger(RateLimitGuard.name);
  private readonly cfg = loadConfig();

  constructor(private readonly limiter: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;

    const req = context.switchToHttp().getRequest<Request>();
    const path = normalizedPath(req);
    // Топология прокси одна на процесс, поэтому источник адреса общий с выдачей подписки:
    // вторая переменная про то же самое означала бы возможность настроить её противоречиво.
    const ip = clientIp(req, this.cfg.subRateLimitTrustProxy);

    for (const check of this.checksFor(req, path, ip)) {
      const decision = await this.limiter.check(check.key, check.rule);
      if (decision.allowed) continue;

      this.log.warn(`лимит ${check.subject}: ${path}, retry-after ${decision.retryAfterSec}s`);
      context.switchToHttp().getResponse<Response>().setHeader("retry-after", String(decision.retryAfterSec));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: "Too Many Requests",
          message: "слишком много запросов, повторите позже",
          retryAfterSec: decision.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private checksFor(req: Request, path: string, ip: string): Check[] {
    if (path === ADMIN_LOGIN_PATH || ADMIN_TELEGRAM_LOGIN_PATHS.includes(path)) {
      // Два ключа сразу: по IP — против перебора пароля одной учётки, по email —
      // против того же перебора, размазанного по ботнету и сменившего IP.
      // У входа по Telegram email в теле нет, поэтому второй ключ не добавится сам.
      const checks: Check[] = [
        { key: `admin-login:ip:${ip}`, rule: this.cfg.adminLoginRateLimitPerIp, subject: `входа с ip ${ip}` },
      ];
      const email = loginEmail(req);
      if (email) {
        checks.push({
          key: `admin-login:email:${email}`,
          rule: this.cfg.adminLoginRateLimitPerEmail,
          subject: "входа по учётке",
        });
      }
      return checks;
    }

    if (isUnderPrefix(path, ADMIN_PATH_PREFIX)) {
      return [{ key: `admin:ip:${ip}`, rule: this.cfg.adminRateLimitPerIp, subject: `админского API с ip ${ip}` }];
    }
    if (isUnderPrefix(path, WEBHOOK_PATH_PREFIX)) {
      return [{ key: `webhook:ip:${ip}`, rule: this.cfg.webhookRateLimitPerIp, subject: `вебхуков с ip ${ip}` }];
    }
    if (isUnderPrefix(path, INTERNAL_PATH_PREFIX)) {
      return [{ key: `internal:ip:${ip}`, rule: this.cfg.internalRateLimitPerIp, subject: `служебного API с ip ${ip}` }];
    }
    return [];
  }
}

/**
 * Email из тела запроса на вход. Гварды в Nest выполняются после парсера тела, так что
 * оно уже разобрано. Обрезка длины — чтобы килобайтная строка не уехала в ключ Redis.
 */
function loginEmail(req: Request): string {
  const raw = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().slice(0, 190);
}
