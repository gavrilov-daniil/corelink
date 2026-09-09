import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { loadConfig } from "../config.js";

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

/** Потолок ключей в памяти — защита от роста Map, если кто-то дёргает /start в цикле. */
const MEMORY_CAP = 10_000;

/**
 * Одноразовые значения на время входа: state с PKCE-верификатором и билет,
 * по которому админка забирает готовую сессию.
 *
 * Хранилище: Redis при заданном REDIS_URL, иначе память процесса — core обязан
 * подниматься без Redis (docs/workers.md). В памяти вход перестаёт работать при
 * втором инстансе api: callback может прийти в процесс, который не выдавал state.
 *
 * FAIL-CLOSED, в отличие от лимитера: не нашли state — вход отклоняем. Пропускать
 * непроверенный callback нельзя, это и есть защита от подмены кода.
 *
 * Чтение всегда со снятием: ни state, ни билет не должны срабатывать дважды.
 */
@Injectable()
export class OidcStore implements OnModuleDestroy {
  private readonly log = new Logger(OidcStore.name);
  private readonly redis: Redis | null;
  private readonly memory = new Map<string, MemoryEntry>();
  private redisErrorLogged = false;

  constructor() {
    const { redisUrl } = loadConfig();
    this.redis = redisUrl ? this.connect(redisUrl) : null;
    if (!this.redis) {
      this.log.warn("REDIS_URL не задан: состояние входа хранится в памяти процесса");
    }
  }

  async put(key: string, value: unknown, ttlSec: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (this.redis) {
      await this.redis.set(key, raw, "EX", ttlSec);
      return;
    }
    this.capMemory();
    this.memory.set(key, { value: raw, expiresAt: Date.now() + ttlSec * 1000 });
  }

  /** Возвращает значение и тут же его удаляет. null — ключа нет, истёк или уже использован. */
  async take<T>(key: string): Promise<T | null> {
    const raw = this.redis ? await this.takeRedis(key) : this.takeMemory(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async takeRedis(key: string): Promise<string | null> {
    // GET и DEL одной транзакцией: между ними не должно быть окна, в котором
    // второй callback с тем же state успеет прочитать значение.
    const result = await this.redis!.multi().get(key).del(key).exec();
    const value = result?.[0]?.[1];
    return typeof value === "string" ? value : null;
  }

  private takeMemory(key: string): string | null {
    const entry = this.memory.get(key);
    this.memory.delete(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  private connect(url: string): Redis {
    const redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 1000 });
    redis.on("error", (err) => {
      if (this.redisErrorLogged) return;
      this.redisErrorLogged = true;
      this.log.error(`redis недоступен, вход по Telegram работать не будет: ${err.message}`);
    });
    redis.on("ready", () => {
      this.redisErrorLogged = false;
    });
    return redis;
  }

  private capMemory(): void {
    if (this.memory.size < MEMORY_CAP) return;
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
    // Протухшие не освободили место — режем самые старые: это не кеш, потеря записи
    // означает лишь «войдите заново».
    while (this.memory.size >= MEMORY_CAP) {
      const oldest = this.memory.keys().next();
      if (oldest.done) break;
      this.memory.delete(oldest.value);
    }
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}
