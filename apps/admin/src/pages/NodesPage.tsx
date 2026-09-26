import { useEffect, useState } from "react";
import {
  NODE_ROLES,
  NODE_STATUSES,
  createCascade,
  createNode,
  deleteNode,
  errorMessage,
  getCascades,
  getConfigProfiles,
  getDesiredState,
  getNodes,
  getServers,
  issueEnrollment,
  rebuildNode,
  refreshCascade,
  updateNode,
  type Cascade,
  type ConfigProfile,
  type DesiredState,
  type Node,
  type Server,
} from "../api";
import { useResource } from "../useResource";
import { formatDateTime } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Modal from "../components/Modal";
import Field from "../components/Field";
import Toggle from "../components/Toggle";
import CopyButton from "../components/CopyButton";
import AgentInstall from "../components/AgentInstall";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

interface RebuildState {
  pending: boolean;
  text?: string;
  failed?: boolean;
}

export default function NodesPage() {
  const page = useResource(async () => {
    const [nodes, cascades, servers, profiles] = await Promise.all([
      getNodes(),
      getCascades(),
      getServers(),
      getConfigProfiles(),
    ]);
    return { nodes, cascades, servers, profiles };
  });

  const [rebuilds, setRebuilds] = useState<Record<string, RebuildState>>({});
  const [stateNodeId, setStateNodeId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nodeForm, setNodeForm] = useState<{ node?: Node } | null>(null);
  const [enrollingNode, setEnrollingNode] = useState<Node | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rebuild = async (node: Node) => {
    setRebuilds((prev) => ({ ...prev, [node.id]: { pending: true } }));
    try {
      const result = await rebuildNode(node.id);
      setRebuilds((prev) => ({
        ...prev,
        [node.id]: {
          pending: false,
          text: result.changed
            ? `версия ${result.version}, hash ${result.hash.slice(0, 12)}…`
            : `без изменений (версия ${result.version})`,
        },
      }));
    } catch (e) {
      setRebuilds((prev) => ({ ...prev, [node.id]: { pending: false, failed: true, text: errorMessage(e) } }));
    }
  };

  const refresh = async (cascade: Cascade) => {
    setRefreshingId(cascade.id);
    setActionError(null);
    try {
      await refreshCascade(cascade.id);
      page.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setRefreshingId(null);
    }
  };

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;

  const { nodes, cascades, servers, profiles } = page.data;
  const nodeName = (id: string | null) => (id ? (nodes.find((n) => n.id === id)?.name ?? id) : "—");

  const nodeColumns: Column<Node>[] = [
    {
      key: "name",
      title: "Нода",
      render: (n) => (
        <div>
          <div className="strong">{n.name}</div>
          <div className="muted small mono">
            {n.serverHostname ?? n.address ?? n.id}
            {n.country ? ` · ${n.country}` : ""}
          </div>
        </div>
      ),
    },
    { key: "roles", title: "Роли", render: (n) => n.roles.join(" + ") || "—" },
    { key: "status", title: "Статус", render: (n) => <StatusBadge status={n.status} /> },
    {
      key: "converged",
      title: "Конфиг",
      render: (n) => (
        <div>
          {n.xrayError ? (
            <StatusBadge status="error" label="Xray не работает" />
          ) : (
            <StatusBadge
              status={n.converged ? "ok" : "pending"}
              label={n.converged ? `сошёлся, v${n.desiredVersion ?? 0}` : `не сошёлся, v${n.desiredVersion ?? 0}`}
            />
          )}
          <div className="muted small mono">
            {shortHash(n.desiredConfigHash)} → {shortHash(n.appliedConfigHash)}
          </div>
          {n.xrayError && <div className="err small">{n.xrayError}</div>}
        </div>
      ),
    },
    { key: "heartbeat", title: "Heartbeat", render: (n) => formatDateTime(n.lastHeartbeatAt) },
    {
      key: "rebuild",
      title: "Пересборка",
      render: (n) => {
        const state = rebuilds[n.id];
        if (!state) return <span className="muted">—</span>;
        if (state.pending) return <span className="muted">собираем…</span>;
        return <span className={state.failed ? "err small" : "muted small"}>{state.text}</span>;
      },
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (n) => (
        <div className="row-actions">
          <button type="button" className="btn btn-sm" onClick={() => setNodeForm({ node: n })}>
            Изменить
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setEnrollingNode(n)}>
            Токен агента
          </button>
          <button type="button" className="btn btn-sm" onClick={() => rebuild(n)} disabled={rebuilds[n.id]?.pending}>
            Пересобрать конфиг
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setStateNodeId(n.id)}>
            Desired-state
          </button>
        </div>
      ),
    },
  ];

  const cascadeColumns: Column<Cascade>[] = [
    { key: "cc", title: "Страна", render: (c) => <span className="strong">{c.cc}</span> },
    {
      key: "kind",
      title: "Тип",
      render: (c) => (c.kind === "server_forward" ? "server_forward (на relay)" : "client_chain (на клиенте)"),
    },
    { key: "status", title: "Статус", render: (c) => <StatusBadge status={c.status} /> },
    {
      key: "exit",
      title: "Exit",
      render: (c) => (
        <div>
          <div>{nodeName(c.exitNodeId)}</div>
          <div className="muted small mono">{c.exitInboundTag}</div>
        </div>
      ),
    },
    { key: "relay", title: "Relay", render: (c) => nodeName(c.relayNodeId) },
    { key: "front", title: "Front", render: (c) => nodeName(c.frontNodeId) },
    { key: "updated", title: "Обновлён", render: (c) => formatDateTime(c.updatedAt) },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (c) => (
        <button type="button" className="btn btn-sm" onClick={() => refresh(c)} disabled={refreshingId === c.id}>
          Обновить статус
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Ноды и каскады</h1>
        <button type="button" className="btn" onClick={page.reload}>
          Обновить
        </button>
      </div>

      {actionError && <ErrorBox error={actionError} />}

      <Card
        title="Ноды"
        subtitle="«Сошёлся» — агент применил ровно ту версию конфига, которую собрала панель. Пока нет, правки до ноды не доехали."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={servers.length === 0 || profiles.length === 0}
            onClick={() => setNodeForm({})}
          >
            Создать ноду
          </button>
        }
      >
        {nodes.length === 0 ? (
          <EmptyState
            text="Нод нет"
            hint="Заведите сервер и config-профиль в разделе «Инфраструктура», затем создайте ноду здесь."
          />
        ) : (
          <Table columns={nodeColumns} rows={nodes} rowKey={(n) => n.id} />
        )}
      </Card>

      <Card
        title="Каскады"
        subtitle="В подписку канал попадает только в статусе active — когда обе ноды применили конфиг."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreating(true)}
            disabled={nodes.length === 0}
          >
            Создать каскад
          </button>
        }
      >
        {cascades.length === 0 ? (
          <EmptyState text="Каскадов нет" hint="Скрестите relay с exit или объявите client-chain через front." />
        ) : (
          <Table columns={cascadeColumns} rows={cascades} rowKey={(c) => c.id} />
        )}
      </Card>

      {stateNodeId && <DesiredStateModal nodeId={stateNodeId} onClose={() => setStateNodeId(null)} />}
      {nodeForm && (
        <NodeModal
          node={nodeForm.node}
          servers={servers}
          profiles={profiles}
          onClose={() => setNodeForm(null)}
          onSaved={() => {
            setNodeForm(null);
            page.reload();
          }}
        />
      )}
      {enrollingNode && <EnrollmentModal node={enrollingNode} onClose={() => setEnrollingNode(null)} />}
      {creating && (
        <CascadeModal
          nodes={nodes}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            page.reload();
          }}
        />
      )}
    </>
  );
}

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 10) : "—";
}

interface NodeModalProps {
  node?: Node;
  servers: Server[];
  profiles: ConfigProfile[];
  onClose: () => void;
  onSaved: () => void;
}

function NodeModal({ node, servers, profiles, onClose, onSaved }: NodeModalProps) {
  const [serverId, setServerId] = useState(node?.serverId ?? servers[0]?.id ?? "");
  const [configProfileId, setConfigProfileId] = useState(node?.configProfileId ?? "");
  const [name, setName] = useState(node?.name ?? "");
  const [roles, setRoles] = useState<string[]>(node?.roles ?? ["exit"]);
  const [status, setStatus] = useState(node?.status ?? "provisioning");
  const [multiplier, setMultiplier] = useState(String(node?.consumptionMultiplier ?? 1));
  const [trackTraffic, setTrackTraffic] = useState(node?.trackTraffic ?? true);
  const [sortOrder, setSortOrder] = useState(String(node?.sortOrder ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // профиль занимает ровно одна нода — свободные плюс свой собственный
  const available = profiles.filter((p) => !p.nodeId || p.nodeId === node?.id);

  const toggleRole = (role: string, on: boolean) =>
    setRoles((prev) => (on ? [...new Set([...prev, role])] : prev.filter((r) => r !== role)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        serverId,
        configProfileId: configProfileId || available[0]?.id || "",
        name: name.trim(),
        roles,
        status,
        consumptionMultiplier: Number(multiplier) || 1,
        trackTraffic,
        sortOrder: Number(sortOrder) || 0,
      };
      if (node) await updateNode(node.id, body);
      else await createNode(body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!node || !window.confirm("Удалить ноду? Сработает, только если на неё нет ссылок.")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteNode(node.id);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={node ? `Нода «${node.name}»` : "Новая нода"}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          {node && (
            <button type="button" className="btn" disabled={busy} onClick={remove}>
              Удалить
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "Сохраняем…" : node ? "Сохранить" : "Создать"}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Сервер" required>
          <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.hostname} ({s.primaryIp})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Config-профиль"
          required
          hint="один профиль — одна нода: Reality-ключи лежат на его inbound'ах"
        >
          <select value={configProfileId} onChange={(e) => setConfigProfileId(e.target.value)}>
            <option value="">— выберите —</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Название" required>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="de1-exit" />
        </Field>
        <Field label="Статус" hint="метка для оператора; агент сам ставит active после первого отчёта">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {NODE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Роли" required hint="первая роль определяет форму конфига ноды">
        <div className="checks">
          {NODE_ROLES.map((role) => (
            <label key={role} className="check">
              <input type="checkbox" checked={roles.includes(role)} onChange={(e) => toggleRole(role, e.target.checked)} />
              <span>{role}</span>
            </label>
          ))}
        </div>
      </Field>

      <div className="grid-2">
        <Field label="Множитель расхода" hint="во сколько раз трафик этой ноды дороже для подписки">
          <input value={multiplier} onChange={(e) => setMultiplier(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Порядок" hint="меньше — выше в списках">
          <input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <Field label="Считать трафик" hint="выключенная нода не расходует лимит подписки">
        <Toggle checked={trackTraffic} onChange={setTrackTraffic} label={trackTraffic ? "да" : "нет"} />
      </Field>
    </Modal>
  );
}

/**
 * Bootstrap-токен показывается ровно один раз: в БД лежит только его sha256.
 * Поэтому окно не закрывается автоматически и не перезагружает список.
 */
function EnrollmentModal({ node, onClose }: { node: Node; onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await issueEnrollment(node.id);
      setToken(result.bootstrapToken);
      setExpiresAt(result.bootstrapExpiresAt);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Энроллмент ноды «${node.name}»`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Закрыть
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={issue}>
            {busy ? "Выпускаем…" : token ? "Выпустить заново" : "Выпустить токен"}
          </button>
        </>
      }
    >
      <div className="kv">
        <div>
          <span className="kv-key">NODE_ID</span>
          <span className="kv-val mono">{node.id}</span>
        </div>
        <div>
          <span className="kv-key">Сервер</span>
          <span className="kv-val">{node.serverHostname ?? node.address ?? "—"}</span>
        </div>
      </div>

      {token ? (
        <>
          <h3 className="form-section">Bootstrap-токен</h3>
          <pre className="code">{token}</pre>
          <div className="row-actions">
            <CopyButton value={token} title="Скопировать токен" />
          </div>
          <p className="warn small">
            Значение видно один раз: в базе лежит только его хеш. Годен до {formatDateTime(expiresAt)}.
          </p>

          <AgentInstall nodeId={node.id} token={token} />
        </>
      ) : (
        <p className="muted small">
          Выпуск инвалидирует прежний неиспользованный токен этой ноды. Действующий токен уже энролленного агента не
          отзывается — нода продолжит работать, пока агент не пройдёт энроллмент заново.
        </p>
      )}
    </Modal>
  );
}

function DesiredStateModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const state = useResource(() => getDesiredState(nodeId), [nodeId]);

  return (
    <Modal title="Desired-state ноды" onClose={onClose} wide>
      {state.loading && <Loading />}
      {state.error && <ErrorBox error={state.error} onRetry={state.reload} />}
      {state.data && (
        <>
          <div className="kv">
            <div>
              <span className="kv-key">Версия</span>
              <span className="kv-val">{state.data.version}</span>
            </div>
            <div>
              <span className="kv-key">Config hash</span>
              <span className="kv-val mono">{state.data.configHash}</span>
            </div>
            <div>
              <span className="kv-key">Собран</span>
              <span className="kv-val">{formatDateTime(state.data.generatedAt)}</span>
            </div>
            <div>
              <span className="kv-key">Пользователей</span>
              <span className="kv-val">{state.data.users.length}</span>
            </div>
            <div>
              <span className="kv-key">Inbound-теги</span>
              <span className="kv-val mono">{inboundTags(state.data).join(", ") || "—"}</span>
            </div>
          </div>
          <h3 className="form-section">Конфиг</h3>
          <pre className="code">{JSON.stringify(state.data.config, null, 2)}</pre>
        </>
      )}
    </Modal>
  );
}

function inboundTags(state: DesiredState): string[] {
  return (state.config.inbounds ?? []).map((i) => i.tag).filter((t): t is string => Boolean(t));
}

interface CascadeModalProps {
  nodes: Node[];
  onClose: () => void;
  onCreated: () => void;
}

function CascadeModal({ nodes, onClose, onCreated }: CascadeModalProps) {
  const [kind, setKind] = useState<"server_forward" | "client_chain">("server_forward");
  const [cc, setCc] = useState("");
  const [exitNodeId, setExitNodeId] = useState(nodes[0]?.id ?? "");
  const [exitInboundTag, setExitInboundTag] = useState("");
  const [relayNodeId, setRelayNodeId] = useState("");
  const [frontNodeId, setFrontNodeId] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!exitNodeId) return;
    let cancelled = false;
    setTags([]);
    setTagsError(null);
    getDesiredState(exitNodeId)
      .then((state) => {
        if (!cancelled) setTags(inboundTags(state));
      })
      .catch((e: unknown) => {
        if (!cancelled) setTagsError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [exitNodeId]);

  const submit = async () => {
    if (!cc.trim() || !exitNodeId || !exitInboundTag.trim()) {
      setError("нужны страна, exit-нода и её inbound-тег");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createCascade({
        kind,
        cc: cc.trim().toUpperCase(),
        exitNodeId,
        exitInboundTag: exitInboundTag.trim(),
        relayNodeId: relayNodeId || undefined,
        frontNodeId: frontNodeId || undefined,
      });
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Новый каскад"
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "Создаём…" : "Создать"}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field
          label="Тип"
          hint={kind === "server_forward" ? "цепочка собирается на relay" : "цепочку собирает клиент"}
        >
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="server_forward">server_forward</option>
            <option value="client_chain">client_chain</option>
          </select>
        </Field>
        <Field label="Страна (cc)" required>
          <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="DE" maxLength={4} />
        </Field>
      </div>

      <Field label="Exit-нода" required>
        <select value={exitNodeId} onChange={(e) => setExitNodeId(e.target.value)}>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} ({n.roles.join("+") || "без ролей"})
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Inbound-тег на exit"
        required
        hint={tagsError ? `теги не подтянулись: ${tagsError}` : "подсказки — из desired-state выбранной ноды"}
      >
        <input
          list="exit-inbound-tags"
          value={exitInboundTag}
          onChange={(e) => setExitInboundTag(e.target.value)}
          placeholder="VLESS_REALITY_DE"
        />
      </Field>
      <datalist id="exit-inbound-tags">
        {tags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      <div className="grid-2">
        <Field label="Relay-нода" hint="для server_forward">
          <select value={relayNodeId} onChange={(e) => setRelayNodeId(e.target.value)}>
            <option value="">—</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Front-нода" hint="для client_chain">
          <select value={frontNodeId} onChange={(e) => setFrontNodeId(e.target.value)}>
            <option value="">—</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
