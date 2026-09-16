import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { requireUuid } from "./infra.validation.js";
import { resolveServerSsh } from "./server-ssh.js";
import { runSshScript } from "./ssh-exec.js";
import { buildProvisionScript } from "./provision-script.js";
import { NodeIdentityService } from "./node-identity.service.js";

const GITHUB_REPO = process.env.GITHUB_REPO ?? "gavrilov-daniil/corelink";
const AGENT_RELEASE = process.env.AGENT_RELEASE ?? "latest";
const XRAY_VERSION = process.env.XRAY_VERSION || undefined;

/** Аренда прогона: живой execute продлевает started_at, resume добирает только то, что старше. */
const LEASE_MS = 15 * 60_000;
const FLUSH_MS = 2_000;
/** Потолок лога в БД: установка verbose, но строка не должна расти без предела. */
const MAX_LOG = 200_000;

/**
 * Авто-настройка сервера по SSH: ставит Xray + node-agent на чистый Debian/Ubuntu и
 * запускает агента (дальше агент dial-out'ом сам поднимает сеть). Один прогон = одна
 * строка provision_run; лог и статус видны в админке.
 *
 * SSH — единственное место, где control-plane сам ходит на ноду, и только на bootstrap:
 * дальше связь строго dial-out. Поэтому провижн вынесен в отдельный сервис, а не в
 * контроллер — запуск fire-and-forget, страховка застрявших — джобой provision-resume.
 */
@Injectable()
export class ProvisionService {
  private readonly log = new Logger(ProvisionService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly identity: NodeIdentityService,
  ) {}

  private get org(): string {
    return this.cfg.defaultOrgId;
  }

  /** Запустить настройку сервера. Возвращает id прогона; сам прогон идёт в фоне. */
  async start(serverId: string, kind: "provision" | "reprovision" = "provision") {
    requireUuid(serverId);
    const server = await this.serverRow(serverId);

    const nodes = await this.db
      .select({ id: schema.node.id })
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.org), eq(schema.node.serverId, serverId)));
    if (nodes.length === 0) bad("на сервере нет ноды — сначала заведите локацию");
    if (nodes.length > 1) bad("на сервере несколько нод — авто-настройка поддерживает одну ноду на сервер");
    const nodeId = nodes[0]!.id;

    // Доступ проверяем до создания прогона: смысла заводить заведомо провальный нет.
    const ssh = resolveServerSsh(server, this.cfg.secretsMasterKey);
    if (!ssh.ok) bad(`SSH-доступ не годится для настройки: ${ssh.detail}`);

    // Идемпотентность запуска: если прогон уже идёт — отдаём его, а не плодим второй.
    const [active] = await this.db
      .select({ id: schema.provisionRun.id })
      .from(schema.provisionRun)
      .where(
        and(
          eq(schema.provisionRun.orgId, this.org),
          eq(schema.provisionRun.serverId, serverId),
          inArray(schema.provisionRun.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (active) return { runId: active.id, already: true };

    const [run] = await this.db
      .insert(schema.provisionRun)
      .values({ orgId: this.org, serverId, nodeId, kind, status: "queued" })
      .returning({ id: schema.provisionRun.id });
    const runId = run!.id;

    void this.execute(runId).catch((err) =>
      this.log.error(`provision ${runId} упал: ${err instanceof Error ? err.message : String(err)}`),
    );
    return { runId, already: false };
  }

  /** Выполнить прогон: claim → ssh-скрипт со стримом лога → финал. Безопасно к повтору. */
  async execute(runId: string): Promise<void> {
    // claim: берём только незавершённый прогон; выставляем running и продлеваем аренду.
    const [claimed] = await this.db
      .update(schema.provisionRun)
      .set({ status: "running", startedAt: new Date(), error: null })
      .where(and(eq(schema.provisionRun.id, runId), inArray(schema.provisionRun.status, ["queued", "running"])))
      .returning();
    if (!claimed) return; // уже success/failed — второй исполнитель не нужен

    const server = await this.serverRow(claimed.serverId);
    const ssh = resolveServerSsh(server, this.cfg.secretsMasterKey);
    if (!ssh.ok) {
      await this.finish(runId, false, `SSH-доступ не годится: ${ssh.detail}`, "");
      return;
    }
    if (!claimed.nodeId) {
      await this.finish(runId, false, "у прогона нет ноды", "");
      return;
    }

    const bootstrap = await this.identity.issueBootstrapToken(claimed.nodeId);
    const script = buildProvisionScript({
      repo: GITHUB_REPO,
      agentRelease: AGENT_RELEASE,
      controlPlaneUrl: `https://${this.cfg.subPublicHost}`,
      nodeId: claimed.nodeId,
      bootstrapToken: bootstrap.bootstrapToken,
      xrayVersion: XRAY_VERSION,
    });

    let acc = `# настройка ${server.hostname} (${ssh.host}) начата ${new Date().toISOString()}\n`;
    const timer = setInterval(() => void this.flush(runId, acc), FLUSH_MS);
    try {
      const result = await runSshScript(
        { host: ssh.host, port: ssh.port, user: ssh.user, creds: ssh.creds },
        script,
        (chunk) => {
          acc = (acc + chunk).slice(-MAX_LOG);
        },
      );
      clearInterval(timer);
      await this.finish(runId, result.ok, result.ok ? null : result.detail, acc);
    } catch (err) {
      clearInterval(timer);
      await this.finish(runId, false, err instanceof Error ? err.message : String(err), acc);
    }
  }

  /** Страховка: прогоны, зависшие в running с протухшей арендой (рестарт core посреди). */
  async resume(): Promise<{ resumed: string[] }> {
    const stale = await this.db
      .select({ id: schema.provisionRun.id })
      .from(schema.provisionRun)
      .where(
        and(
          eq(schema.provisionRun.status, "running"),
          lt(schema.provisionRun.startedAt, new Date(Date.now() - LEASE_MS)),
        ),
      );
    const resumed: string[] = [];
    for (const r of stale) {
      void this.execute(r.id).catch((err) =>
        this.log.error(`resume provision ${r.id}: ${err instanceof Error ? err.message : String(err)}`),
      );
      resumed.push(r.id);
    }
    return { resumed };
  }

  async getRun(runId: string) {
    requireUuid(runId);
    const [run] = await this.db
      .select()
      .from(schema.provisionRun)
      .where(and(eq(schema.provisionRun.orgId, this.org), eq(schema.provisionRun.id, runId)))
      .limit(1);
    if (!run) throw new NotFoundException(`прогон ${runId} не найден`);
    return run;
  }

  async listRuns(serverId: string, limit = 10) {
    requireUuid(serverId);
    return this.db
      .select()
      .from(schema.provisionRun)
      .where(and(eq(schema.provisionRun.orgId, this.org), eq(schema.provisionRun.serverId, serverId)))
      .orderBy(desc(schema.provisionRun.createdAt))
      .limit(limit);
  }

  /** Промежуточный сброс лога и продление аренды: оператор видит прогресс в реальном времени. */
  private async flush(runId: string, log: string): Promise<void> {
    await this.db
      .update(schema.provisionRun)
      .set({ log, startedAt: new Date() })
      .where(and(eq(schema.provisionRun.id, runId), eq(schema.provisionRun.status, "running")));
  }

  private async finish(runId: string, ok: boolean, error: string | null, log: string): Promise<void> {
    await this.db
      .update(schema.provisionRun)
      .set({ status: ok ? "success" : "failed", error, log, finishedAt: new Date() })
      .where(eq(schema.provisionRun.id, runId));
    this.log.log(`provision ${runId}: ${ok ? "success" : `failed — ${error}`}`);
  }

  private async serverRow(serverId: string): Promise<typeof schema.server.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(schema.server)
      .where(and(eq(schema.server.orgId, this.org), eq(schema.server.id, serverId)))
      .limit(1);
    if (!row) throw new NotFoundException(`сервер ${serverId} не найден`);
    return row;
  }
}

function bad(msg: string): never {
  throw new BadRequestException(msg);
}
