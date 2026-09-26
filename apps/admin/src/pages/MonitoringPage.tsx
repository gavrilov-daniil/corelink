import { useEffect, useRef, useState } from "react";
import {
  enqueueJob,
  errorMessage,
  getMonitoring,
  type MonitoringChannel,
  type MonitoringNode,
  type MonitoringOverview,
  type MonitoringProbe,
} from "../api";
import { useResource } from "../useResource";
import { useCan } from "../session";
import { formatAgo, formatDateTime } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

/** Плановая проба — раз в 5 минут; прогон старше 15 — мониторинг молчит, а не «всё хорошо». */
const STALE_PROBE_MS = 15 * 60_000;
const REFRESH_MS = 60_000;
/** Ручная проба идёт воркером: ждём, пока у точки dc сменится время прогона (с ожиданием нод — до ~2 мин). */
const PROBE_POLL_MS = 5_000;
const PROBE_WAIT_MS = 180_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function uptime(c: MonitoringChannel): string {
  if (c.checks24h === 0) return "—";
  return `${Math.round((c.passed24h / c.checks24h) * 100)}% (${c.passed24h}/${c.checks24h})`;
}

/** Итог ручного прогона — по каналам, проверенным после прежнего прогона точки. */
function probeSummary(data: MonitoringOverview, dc: MonitoringProbe, before: string | null): string {
  if (dc.lastError) return `Проба не выполнилась: ${dc.lastError}`;
  const fresh = data.channels.filter((c) => c.probeId === dc.id && (!before || c.checkedAt > before));
  if (fresh.length === 0) return "Проба прошла, но проверять нечего: каналов нет.";
  const failed = fresh
    .filter((c) => !c.ok)
    .map((c) => data.nodes.find((n) => n.id === c.nodeId)?.name ?? c.channelTag);
  return failed.length === 0
    ? `Проверено каналов: ${fresh.length}, все работают.`
    : `Проверено каналов: ${fresh.length}, не прошли: ${failed.join(", ")}.`;
}

export default function MonitoringPage() {
  const page = useResource(getMonitoring);
  const canRun = useCan("admin");
  const [running, setRunning] = useState(false);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // тихое обновление раз в минуту: страницу держат открытой, как табло
  useEffect(() => {
    const timer = setInterval(() => {
      getMonitoring().then(page.setData, () => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [page.setData]);

  const runNow = async () => {
    const before = page.data?.probes.find((p) => p.kind === "dc")?.lastRunAt ?? null;
    setRunning(true);
    setRunNotice(null);
    try {
      await enqueueJob("node-probe");
      for (const deadline = Date.now() + PROBE_WAIT_MS; Date.now() < deadline; ) {
        await sleep(PROBE_POLL_MS);
        if (!mounted.current) return;
        const next = await getMonitoring();
        page.setData(next);
        const dc = next.probes.find((p) => p.kind === "dc");
        if (dc?.lastRunAt && dc.lastRunAt !== before) {
          setRunNotice(probeSummary(next, dc, before));
          return;
        }
      }
      setRunNotice("Воркер не выполнил пробу за 3 минуты — проверьте, запущен ли он.");
    } catch (e) {
      setRunNotice(`Проба не запустилась: ${errorMessage(e)}`);
    } finally {
      if (mounted.current) setRunning(false);
    }
  };

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;

  const { probes, channels, nodes, events } = page.data;
  const nodeName = (id: string | null) => nodes.find((n) => n.id === id)?.name ?? "удалённая нода";
  const probeName = (id: string | null) => probes.find((p) => p.id === id)?.name ?? "проба";

  const nodeColumns: Column<MonitoringNode>[] = [
    {
      key: "node",
      title: "Нода",
      render: (n) => (
        <div>
          <div className="strong">{n.name}</div>
          <div className="muted small">{n.country ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "agent",
      title: "Агент и Xray",
      render: (n) => (
        <div>
          {n.xrayError ? (
            <StatusBadge status="error" label="Xray не работает" />
          ) : (
            <StatusBadge status={n.heartbeatAt ? "ok" : "pending"} label={n.heartbeatAt ? "на связи" : "ни разу"} />
          )}
          <div className="muted small">heartbeat: {formatAgo(n.heartbeatAt)}</div>
          {n.xrayError && <div className="err small">{n.xrayError}</div>}
        </div>
      ),
    },
    {
      key: "probe",
      title: "Проба (трафик через канал)",
      render: (n) => {
        const own = channels.filter((c) => c.nodeId === n.id);
        if (own.length === 0) return <span className="muted small">нет каналов — нечего проверять</span>;
        return (
          <div>
            {own.map((c) => (
              <div key={`${c.probeId}:${c.channelTag}`} className="monitor-channel">
                <StatusBadge
                  status={c.ok ? "ok" : "error"}
                  label={c.ok ? `работает, ${c.latencyMs ?? "?"} мс` : "не проходит"}
                />
                <span className="muted small">
                  {" "}
                  {probeName(c.probeId)} · сутки: {uptime(c)} · {formatAgo(c.checkedAt)}
                </span>
                {!c.ok && c.error && <div className="err small">{c.error}</div>}
              </div>
            ))}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Мониторинг</h1>
        <div className="head-tools">
          {canRun && (
            <button type="button" className="btn btn-primary" disabled={running} onClick={() => void runNow()}>
              {running ? "Проба идёт…" : "Проверить сейчас"}
            </button>
          )}
          <button type="button" className="btn" onClick={page.reload}>
            Обновить
          </button>
        </div>
      </div>

      {runNotice && <div className="notice">{runNotice}</div>}

      <Card
        title="Точки наблюдения"
        subtitle="Откуда гоняется трафик. Из дата-центра блокировки ТСПУ не видны — для них нужна точка в домашней сети."
      >
        {probes.length === 0 ? (
          <EmptyState
            text="Проба ещё не запускалась"
            hint="Первый прогон — в течение 5 минут после выкатки, или кнопкой «Проверить сейчас»."
          />
        ) : (
          probes.map((p) => <ProbeRow key={p.id} probe={p} />)
        )}
      </Card>

      <Card title="Ноды" subtitle="Агент и Xray — со слов ноды; проба — настоящий трафик через канал, как у клиента.">
        {nodes.length === 0 ? (
          <EmptyState text="Нод нет" />
        ) : (
          <Table columns={nodeColumns} rows={nodes} rowKey={(n) => n.id} />
        )}
      </Card>

      <Card title="События" subtitle="Переходы «работал → упал» и обратно. Повторный провал ленту не засоряет.">
        {events.length === 0 ? (
          <EmptyState text="Событий нет" hint="Здесь появятся падения и восстановления каналов." />
        ) : (
          <div>
            {events.map((e) => (
              <div key={e.id} className="list-row">
                <div>
                  <StatusBadge
                    status={e.kind === "probe_up" ? "ok" : "error"}
                    label={e.kind === "probe_up" ? "восстановился" : "упал"}
                  />{" "}
                  <span className="strong">{nodeName(e.nodeId)}</span>
                  <span className="muted small"> · {e.channelTag ?? "—"} · {probeName(e.probeId)}</span>
                  {e.message && <div className="small">{e.message}</div>}
                </div>
                <span className="muted small">{formatDateTime(e.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

/** Здоровье самой пробы: давно не запускалась или упала — данные ниже устарели. */
function ProbeRow({ probe }: { probe: MonitoringProbe }) {
  const lastRun = probe.lastRunAt ? new Date(probe.lastRunAt).getTime() : 0;
  const stale = !lastRun || Date.now() - lastRun > STALE_PROBE_MS;
  return (
    <div className="list-row">
      <div>
        <div className="strong">{probe.name}</div>
        <div className="muted small">последний прогон: {formatAgo(probe.lastRunAt)}</div>
        {probe.lastError && <div className="err small">проба не выполнилась: {probe.lastError}</div>}
        {!probe.lastError && stale && (
          <div className="warn small">
            проба не запускалась больше 15 минут — жив ли воркер? Данные ниже могут быть устаревшими.
          </div>
        )}
      </div>
      <StatusBadge
        status={probe.lastError || stale ? "error" : "ok"}
        label={probe.lastError ? "сбой пробы" : stale ? "молчит" : "работает"}
      />
    </div>
  );
}
