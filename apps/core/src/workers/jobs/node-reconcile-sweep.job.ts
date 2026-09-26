import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { NodeStateService } from "../../nodes/node-state.service.js";
import { CascadeService } from "../../nodes/cascade.service.js";
import { AlertService, dayBucket } from "../alert.service.js";
import type { JobRunner } from "../job.types.js";

const HEARTBEAT_STALE_MS = 10 * 60_000;

/**
 * Safety-net, закрывающий разрыв commit→enqueue: оплата прошла, модель изменилась,
 * а пересборку desired-state никто не дёрнул. Сначала пересобираем всё (rebuild — no-op,
 * если конфиг тот же), потом ищем разъезд.
 *
 * Ноды, которым конфиг только что подняли в этом же прогоне, из алертов исключаются:
 * у них desired != applied по определению, агент ещё не успел забрать.
 */
@Injectable()
export class NodeReconcileSweepJob implements JobRunner {
  readonly jobName = "node-reconcile-sweep" as const;
  private readonly log = new Logger(NodeReconcileSweepJob.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly nodes: NodeStateService,
    private readonly cascades: CascadeService,
    private readonly alerts: AlertService,
  ) {}

  async run() {
    const rebuild = await this.nodes.rebuildAll();
    const justRebuilt = new Set(rebuild.changed);

    const rows = await this.db
      .select({ node: schema.node, desired: schema.nodeDesiredState, reported: schema.nodeReportedState })
      .from(schema.node)
      .leftJoin(schema.nodeDesiredState, eq(schema.nodeDesiredState.nodeId, schema.node.id))
      .leftJoin(schema.nodeReportedState, eq(schema.nodeReportedState.nodeId, schema.node.id))
      .where(eq(schema.node.orgId, this.cfg.defaultOrgId));

    const now = Date.now();
    const bucket = dayBucket();
    const drifted: Array<{ nodeId: string; name: string; reasons: string[] }> = [];

    for (const row of rows) {
      if (justRebuilt.has(row.node.id)) continue;

      const reasons: string[] = [];
      if (row.desired && row.desired.configHash !== row.reported?.appliedConfigHash) {
        reasons.push("config_drift");
      }
      if (row.reported?.xrayError) {
        reasons.push("xray_down");
      }
      const heartbeatAt = row.reported?.heartbeatAt ?? null;
      if (!heartbeatAt || now - heartbeatAt.getTime() > HEARTBEAT_STALE_MS) {
        reasons.push("stale_heartbeat");
      }
      if (reasons.length === 0) continue;

      drifted.push({ nodeId: row.node.id, name: row.node.name, reasons });
      this.log.warn(`node ${row.node.name} (${row.node.id}): ${reasons.join(", ")}`);
      await this.alerts.alertOnce(
        `node_reconcile:${row.node.id}:${bucket}`,
        alertText(
          row.node.name,
          reasons,
          row.desired?.configHash ?? null,
          row.reported?.appliedConfigHash ?? null,
          heartbeatAt,
          row.reported?.xrayError ?? null,
        ),
      );
    }

    // Статусы каскадов обычно пересчитываются по отчёту агента. Если агент замолчал
    // совсем, отчёта не будет — и канал завис бы в active, продолжая раздаваться
    // клиентам. Здесь пересчитываем принудительно для всех нод.
    let cascadesChecked = 0;
    for (const row of rows) {
      cascadesChecked += await this.cascades.refreshForNode(row.node.id);
    }

    return {
      nodesTotal: rebuild.total,
      nodesRebuilt: rebuild.changed.length,
      nodesFailed: rebuild.failed.length,
      cascadesChecked,
      drifted,
    };
  }
}

function alertText(
  name: string,
  reasons: string[],
  desiredHash: string | null,
  appliedHash: string | null,
  heartbeatAt: Date | null,
  xrayError: string | null,
): string {
  const lines = [`⚠️ Нода <b>${name}</b> разъехалась: ${reasons.join(", ")}`];
  if (reasons.includes("config_drift")) {
    lines.push(`desired: ${short(desiredHash)} / applied: ${short(appliedHash)}`);
  }
  if (xrayError) {
    lines.push(`xray: ${escapeHtml(xrayError.slice(0, 300))}`);
  }
  if (reasons.includes("stale_heartbeat")) {
    lines.push(`heartbeat: ${heartbeatAt ? heartbeatAt.toISOString() : "никогда"}`);
  }
  return lines.join("\n");
}

function short(hash: string | null): string {
  return hash ? hash.slice(0, 12) : "—";
}

// Алерт уходит в Telegram с parse_mode=HTML, а в ошибках Xray есть «>» — без
// экранирования Telegram отверг бы сообщение целиком.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
