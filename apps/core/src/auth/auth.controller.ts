import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service.js";
import { Operator } from "./operator.decorator.js";
import { MinRole, PublicRoute, requireOwnOperatorId, type OperatorContext } from "./roles.js";
import { TelegramOidcService } from "./telegram-oidc.service.js";

/**
 * Кука связывает начатый вход с браузером. Путь сужен до самих ручек входа:
 * на остальные запросы админки она не отправляется вовсе.
 */
const BINDER_COOKIE = "cl_tg_oidc";
const BINDER_PATH = "/api/admin/auth/telegram";
const BINDER_TTL_SEC = 600;

/**
 * Вход и управление учётками. Без @MinRole действует `admin` — то есть всё, что
 * заводит и правит операторов, закрыто от support по умолчанию; собственный профиль
 * и выход помечены `support` явно.
 */
@Controller("api/admin/auth")
export class AuthController {
  private readonly log = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly telegram: TelegramOidcService,
  ) {}

  @Post("login")
  @PublicRoute()
  async login(@Body() body: { email: string; password: string }, @Req() req: Request) {
    if (!body?.email || !body?.password) throw new UnauthorizedException("нужны email и пароль");
    return this.auth.login({
      email: body.email,
      password: body.password,
      userAgent: req.headers["user-agent"] as string | undefined,
      ip: req.ip,
    });
  }

  /** Публично: страница входа рисует кнопку Telegram, только если он настроен и включён. */
  @Get("telegram/config")
  @PublicRoute()
  telegramConfig() {
    return this.telegram.publicConfig();
  }

  /**
   * Начало входа через Telegram Web Login. Ответ — адрес экрана Telegram; туда
   * админка уходит сама. Кука с этим же ответом привязывает начатый вход к браузеру.
   */
  @Post("telegram/start")
  @PublicRoute()
  async telegramStart(@Res({ passthrough: true }) res: Response) {
    const started = await this.telegram.start({ intent: "login" });
    setBinderCookie(res, started);
    return { url: started.url };
  }

  /** Привязка Telegram к своей учётке идёт тем же флоу — отличается только намерением. */
  @Post("telegram/link/start")
  @MinRole("support")
  async telegramLinkStart(@Operator() operator: OperatorContext, @Res({ passthrough: true }) res: Response) {
    const started = await this.telegram.start({
      intent: "link",
      operatorId: requireOwnOperatorId(operator),
    });
    setBinderCookie(res, started);
    return { url: started.url };
  }

  /**
   * Возврат от Telegram. Сюда приходит браузер, а не наш код, поэтому результат
   * кладётся в одноразовый билет и отдаётся ссылкой: токен сессии в адресной
   * строке остался бы в истории браузера и в логах прокси.
   */
  @Get("telegram/callback")
  @PublicRoute()
  async telegramCallback(
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const home = await this.telegram.appOrigin();
    res.clearCookie(BINDER_COOKIE, { path: BINDER_PATH });

    if (query.error || !query.code || !query.state) {
      return res.redirect(`${home}/?tg_error=denied`);
    }

    try {
      const finished = await this.telegram.finish({
        code: query.code,
        state: query.state,
        binder: readCookie(req, BINDER_COOKIE),
      });

      const result =
        finished.intent === "link" && finished.operatorId
          ? { status: "linked" as const, ...(await this.auth.linkTelegram(finished.identity, finished.operatorId)) }
          : await this.auth.loginWithTelegram({
              identity: finished.identity,
              userAgent: req.headers["user-agent"] as string | undefined,
              ip: req.ip,
            });

      const ticket = await this.telegram.issueTicket(result);
      return res.redirect(`${home}/?tg=${encodeURIComponent(ticket)}`);
    } catch (err) {
      this.logCallbackFailure(err);
      return res.redirect(`${home}/?tg_error=failed`);
    }
  }

  /**
   * Обмен билета на сессию. Билет одноразовый и живёт минуту, поэтому отдельной
   * защиты от повтора здесь не нужно — второй запрос вернёт «ссылка устарела».
   */
  @Post("telegram/exchange")
  @PublicRoute()
  async telegramExchange(@Body() body: { ticket?: string }) {
    const result = await this.telegram.takeTicket<unknown>(body?.ticket ?? "");
    if (!result) throw new BadRequestException("ссылка входа устарела, попробуйте ещё раз");
    return result;
  }

  @Post("logout")
  @MinRole("support")
  logout(@Headers("x-admin-token") token?: string) {
    if (!token) return { ok: true };
    return this.auth.logout(token);
  }

  /**
   * Кто я — по этому админка рисует имя оператора и набор доступных экранов.
   * Профиль целиком приходит из гварда: он уже прочитал учётку, резолвя сессию.
   */
  @Get("me")
  @MinRole("support")
  me(@Operator() operator: OperatorContext) {
    return operator;
  }

  @Delete("telegram/link")
  @MinRole("support")
  unlinkOwnTelegram(@Operator() operator: OperatorContext) {
    return this.auth.unlinkTelegram(requireOwnOperatorId(operator), operator);
  }

  /** Смена собственного пароля. Чужой — через operators/:id/password. */
  @Post("password")
  @MinRole("support")
  changeOwnPassword(@Body() body: { password: string }, @Operator() operator: OperatorContext) {
    return this.auth.changePassword(requireOwnOperatorId(operator), body?.password ?? "", operator);
  }

  // --- управление учётками: admin и выше --------------------------------------

  @Get("operators")
  listOperators() {
    return this.auth.listOperators();
  }

  @Post("operators")
  createOperator(
    @Body() body: { email: string; password: string; role?: string; displayName?: string },
    @Operator() operator: OperatorContext,
  ) {
    return this.auth.createOperator(body, operator);
  }

  @Post("operators/:id/approve")
  approve(@Param("id") id: string, @Body() body: { role: string }, @Operator() operator: OperatorContext) {
    return this.auth.approveOperator(id, body?.role ?? "support", operator);
  }

  @Patch("operators/:id")
  update(
    @Param("id") id: string,
    @Body() body: { role?: string; status?: "active" | "disabled" },
    @Operator() operator: OperatorContext,
  ) {
    if (body?.role === undefined && body?.status === undefined) {
      throw new BadRequestException("нечего менять: ожидается role или status");
    }
    return this.auth.updateOperator(id, body, operator);
  }

  @Post("operators/:id/password")
  changePassword(@Param("id") id: string, @Body() body: { password: string }, @Operator() operator: OperatorContext) {
    return this.auth.changePassword(id, body?.password ?? "", operator);
  }

  @Delete("operators/:id/telegram")
  unlinkTelegram(@Param("id") id: string, @Operator() operator: OperatorContext) {
    return this.auth.unlinkTelegram(id, operator);
  }

  // --- настройки входа по Telegram --------------------------------------------

  @Get("telegram/settings")
  telegramSettings() {
    return this.telegram.settingsForAdmin();
  }

  @Patch("telegram/settings")
  updateTelegramSettings(
    @Body()
    body: {
      isEnabled?: boolean;
      botUsername?: string;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
    },
  ) {
    return this.telegram.updateSettings(body ?? {});
  }

  /**
   * Причину провала callback знает только лог: наружу уходит редирект без деталей,
   * иначе подбирающий state читал бы по тексту, какая проверка не прошла.
   */
  private logCallbackFailure(err: unknown) {
    this.log.warn(`вход по Telegram не состоялся: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function setBinderCookie(res: Response, started: { binder: string; origin: string }) {
  res.cookie(BINDER_COOKIE, started.binder, {
    httpOnly: true,
    // Lax, а не Strict: возврат от Telegram — это переход по ссылке с чужого сайта,
    // при Strict куку браузер бы не отправил и вход ломался бы всегда.
    sameSite: "lax",
    // Secure по origin самой админки: на http://localhost такая кука не сохранится,
    // и локальная отладка входа стала бы невозможной.
    secure: started.origin.startsWith("https://"),
    path: BINDER_PATH,
    maxAge: BINDER_TTL_SEC * 1000,
  });
}

/** Куки читаем сами: ради одного значения тащить cookie-parser в общий пайплайн незачем. */
function readCookie(req: Request, name: string): string {
  const header = req.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
