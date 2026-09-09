/**
 * Вход по Telegram Web Login: настройки и те проверки флоу, что срабатывают
 * до похода в Telegram. Обмен кода и подпись id_token здесь не проверяются —
 * это чужой сервер и чужие ключи; наша часть заканчивается на state, PKCE и куке.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { cleanupOrg, closeDb, openDb, TEST_ORG_ID } from "../testing/fixtures.test.js";
import { OidcStore } from "./oidc-store.js";
import { TelegramOidcService } from "./telegram-oidc.service.js";

const CLIENT_ID = "7777777";
const CLIENT_SECRET = "test-client-secret-value";
const REDIRECT_URI = "https://admin.example.org/api/admin/auth/telegram/callback";

let db: Database;
let store: OidcStore;
let telegram: TelegramOidcService;

/** state из выданной ссылки: именно его Telegram вернёт на callback. */
function stateFrom(url: string): string {
  return new URL(url).searchParams.get("state") ?? "";
}

before(async () => {
  db = openDb();
  store = new OidcStore();
  telegram = new TelegramOidcService(db, store);
  await telegram.updateSettings({
    isEnabled: true,
    botUsername: "corelink_ops_bot",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
});

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
  await store.onModuleDestroy();
});

describe("настройки входа", () => {
  it("секрет наружу не отдаётся", async () => {
    const settings = await telegram.settingsForAdmin();

    assert.equal(settings.hasClientSecret, true);
    assert.equal(settings.clientId, CLIENT_ID);
    assert.equal((settings as Record<string, unknown>).clientSecret, undefined);
  });

  it("в БД секрет лежит зашифрованным", async () => {
    // Фильтр по org обязателен: в dev-базе лежит и настоящая строка настроек.
    const [row] = await db
      .select()
      .from(schema.telegramAuthSetting)
      .where(eq(schema.telegramAuthSetting.orgId, TEST_ORG_ID));

    assert.notEqual(row.clientSecret, CLIENT_SECRET);
    assert.ok(row.clientSecret.startsWith("v1."), "формат шифртекста тот же, что у кредов мерчантов");
  });

  it("включить без client_id или секрета нельзя", async () => {
    await assert.rejects(() => telegram.updateSettings({ isEnabled: true, clientSecret: "" }), /нужны client_id/);
    // Секрет вернули на место: следующие тесты работают с настроенным входом.
    await telegram.updateSettings({ isEnabled: true, clientSecret: CLIENT_SECRET });
  });

  it("redirect_uri обязан быть полным адресом", async () => {
    await assert.rejects(() => telegram.updateSettings({ redirectUri: "admin.example.org/callback" }), /https/);
  });

  it("пустой clientSecret в патче не затирает сохранённый", async () => {
    await telegram.updateSettings({ botUsername: "corelink_ops_bot" });

    assert.equal((await telegram.settingsForAdmin()).hasClientSecret, true);
  });
});

describe("начало входа", () => {
  it("ссылка ведёт на Telegram и несёт PKCE-вызов", async () => {
    const started = await telegram.start({ intent: "login" });
    const url = new URL(started.url);

    assert.equal(url.origin + url.pathname, "https://oauth.telegram.org/auth");
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge")?.length, 43, "вызов PKCE — SHA-256 в base64url; без него перехваченный код сработал бы сам по себе");
    assert.ok(url.searchParams.get("state"));
    // id телеграмного пользователя приходит только со scope profile — без него
    // оператора не с чем связать.
    assert.ok(url.searchParams.get("scope")?.includes("profile"));
    assert.ok(started.binder.length >= 32, "связующее значение должно быть непредсказуемым");
    assert.equal(started.origin, "https://admin.example.org");
  });

  it("каждый вход получает свой state и своё связующее значение", async () => {
    const first = await telegram.start({ intent: "login" });
    const second = await telegram.start({ intent: "login" });

    assert.notEqual(stateFrom(first.url), stateFrom(second.url));
    assert.notEqual(first.binder, second.binder);
  });

  it("выключенный вход ссылку не выдаёт", async () => {
    await telegram.updateSettings({ isEnabled: false });

    await assert.rejects(() => telegram.start({ intent: "login" }), /выключен/);

    await telegram.updateSettings({ isEnabled: true });
  });
});

describe("возврат от Telegram", () => {
  it("чужая кука не проходит: иначе подсунутый код логинил бы под чужим аккаунтом", async () => {
    const started = await telegram.start({ intent: "login" });

    await assert.rejects(
      () =>
        telegram.finish({
          code: "any",
          state: stateFrom(started.url),
          binder: randomBytes(32).toString("base64url"),
        }),
      /не подтверждена/,
    );
  });

  it("пустая кука не проходит", async () => {
    const started = await telegram.start({ intent: "login" });

    await assert.rejects(
      () => telegram.finish({ code: "any", state: stateFrom(started.url), binder: "" }),
      /не подтверждена/,
    );
  });

  it("state срабатывает один раз", async () => {
    const started = await telegram.start({ intent: "login" });
    const state = stateFrom(started.url);

    // Первый заход валится уже на обмене кода (сети в тестах нет), но state при этом снят.
    await telegram.finish({ code: "wrong", state, binder: started.binder }).catch(() => undefined);

    await assert.rejects(
      () => telegram.finish({ code: "wrong", state, binder: started.binder }),
      /устарела/,
      "повтор с тем же state обязан отвергаться: иначе перехваченная ссылка работает дважды",
    );
  });

  it("неизвестный state отвергается", async () => {
    await assert.rejects(
      () => telegram.finish({ code: "any", state: randomBytes(32).toString("base64url"), binder: "x" }),
      /устарела/,
    );
  });
});

describe("билет на сессию", () => {
  it("обменивается ровно один раз", async () => {
    const ticket = await telegram.issueTicket({ status: "ok", token: "session-token" });

    assert.deepEqual(await telegram.takeTicket(ticket), { status: "ok", token: "session-token" });
    assert.equal(await telegram.takeTicket(ticket), null, "повтор не должен возвращать сессию второй раз");
  });

  it("подделанный билет ничего не возвращает", async () => {
    assert.equal(await telegram.takeTicket(randomBytes(32).toString("base64url")), null);
  });
});
