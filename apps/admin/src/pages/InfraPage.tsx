import { useState, type ReactNode } from "react";
import {
  FINGERPRINTS,
  INBOUND_FLOWS,
  INBOUND_NETWORKS,
  NODE_ROLES,
  checkServerSsh,
  createConfigProfile,
  createHost,
  createInbound,
  createServer,
  createSquad,
  deleteConfigProfile,
  deleteHost,
  deleteInbound,
  deleteServer,
  deleteSquad,
  errorMessage,
  getConfigProfiles,
  getHosts,
  getInbounds,
  getNodes,
  getServers,
  getSquads,
  issueEnrollment,
  provisionLocation,
  updateConfigProfile,
  updateHost,
  updateInbound,
  updateServer,
  updateSquad,
  type ConfigProfile,
  type Host,
  type Inbound,
  type Node,
  type ProvisionResult,
  type RebuildInfo,
  type Server,
  type SshAuthType,
  type Squad,
} from "../api";
import { useResource } from "../useResource";
import { formatDateTime } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Modal from "../components/Modal";
import Field from "../components/Field";
import Toggle from "../components/Toggle";
import StatusBadge from "../components/StatusBadge";
import CopyButton from "../components/CopyButton";
import AgentInstall from "../components/AgentInstall";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

type Mode = "simple" | "advanced";

const MODE_KEY = "infra-mode";

/** Режим страницы держим между заходами: оператор выбирает его один раз. */
function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "advanced" ? "advanced" : "simple";
  } catch {
    return "simple";
  }
}

function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // приватный режим/заблокированное хранилище — не критично, просто не запомним
  }
}

type Editing<T> = { kind: "create" } | { kind: "edit"; row: T } | null;

export default function InfraPage() {
  const page = useResource(async () => {
    const [servers, profiles, nodes, inbounds, hosts, squads] = await Promise.all([
      getServers(),
      getConfigProfiles(),
      getNodes(),
      getInbounds(),
      getHosts(),
      getSquads(),
    ]);
    return { servers, profiles, nodes, inbounds, hosts, squads };
  });

  const [serverForm, setServerForm] = useState<Editing<Server>>(null);
  const [profileForm, setProfileForm] = useState<Editing<ConfigProfile>>(null);
  const [inboundForm, setInboundForm] = useState<Editing<Inbound>>(null);
  const [hostForm, setHostForm] = useState<Editing<Host>>(null);
  const [squadForm, setSquadForm] = useState<Editing<Squad>>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(loadMode);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [enrollTarget, setEnrollTarget] = useState<{ id: string; name: string } | null>(null);
  const [sshChecks, setSshChecks] = useState<Record<string, CheckState>>({});

  const switchMode = (next: Mode) => {
    setMode(next);
    saveMode(next);
  };

  const done = (close: () => void) => (rebuilt?: RebuildInfo[]) => {
    close();
    setNotice(describeRebuild(rebuilt));
    page.reload();
  };

  const runSshCheck = async (server: Server) => {
    setSshChecks((prev) => ({ ...prev, [server.id]: { pending: true } }));
    try {
      const result = await checkServerSsh(server.id);
      setSshChecks((prev) => ({ ...prev, [server.id]: { pending: false, ...result } }));
      page.reload();
    } catch (e) {
      setSshChecks((prev) => ({ ...prev, [server.id]: { pending: false, ok: false, detail: errorMessage(e) } }));
    }
  };

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;

  const { servers, profiles, nodes, inbounds, hosts, squads } = page.data;
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

  const serverColumns: Column<Server>[] = [
    {
      key: "hostname",
      title: "Сервер",
      render: (s) => (
        <div>
          <div className="strong">{s.hostname}</div>
          <div className="muted small mono">{[s.primaryIp, ...s.extraIps].join(", ")}</div>
        </div>
      ),
    },
    { key: "country", title: "Страна", render: (s) => s.country ?? "—" },
    { key: "agent", title: "Агент", render: (s) => <StatusBadge status={s.agentStatus} /> },
    { key: "versions", title: "Версии", render: (s) => [s.agentVersion, s.xrayVersion].filter(Boolean).join(" / ") || "—" },
    {
      key: "ssh",
      title: "SSH-доступ",
      render: (s) => <ServerSshCell server={s} check={sshChecks[s.id]} onCheck={() => runSshCheck(s)} />,
    },
    { key: "nodes", title: "Нод", align: "right", render: (s) => s.nodeCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (s) => (
        <button type="button" className="btn btn-sm" onClick={() => setServerForm({ kind: "edit", row: s })}>
          Изменить
        </button>
      ),
    },
  ];

  const profileColumns: Column<ConfigProfile>[] = [
    { key: "name", title: "Профиль", render: (p) => <span className="strong">{p.name}</span> },
    {
      key: "node",
      title: "Нода",
      render: (p) => p.nodeName ?? <span className="muted">свободен</span>,
    },
    { key: "inbounds", title: "Inbound'ов", align: "right", render: (p) => p.inboundCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (p) => (
        <button type="button" className="btn btn-sm" onClick={() => setProfileForm({ kind: "edit", row: p })}>
          Изменить
        </button>
      ),
    },
  ];

  const inboundColumns: Column<Inbound>[] = [
    {
      key: "tag",
      title: "Inbound",
      render: (i) => (
        <div>
          <div className="strong mono">{i.tag}</div>
          <div className="muted small">
            {profileName(i.configProfileId)}
            {i.nodeName ? ` → ${i.nodeName}` : " → нода не заведена"}
          </div>
        </div>
      ),
    },
    { key: "port", title: "Порт", align: "right", render: (i) => i.port },
    { key: "transport", title: "Транспорт", render: (i) => `${i.network}/${i.security}${i.flow ? ` +${i.flow}` : ""}` },
    { key: "sni", title: "SNI", render: (i) => i.sni ?? <span className="err">не задан</span> },
    { key: "fp", title: "Fingerprint", render: (i) => i.fingerprint ?? "—" },
    {
      key: "reality",
      title: "Reality",
      render: (i) =>
        i.realityPublicKey ? (
          <span className="mono small">{`${i.realityPublicKey.slice(0, 10)}… / ${i.shortIds.join(",") || "—"}`}</span>
        ) : (
          <span className="warn small">ждёт энроллмента</span>
        ),
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (i) => (
        <button type="button" className="btn btn-sm" onClick={() => setInboundForm({ kind: "edit", row: i })}>
          Изменить
        </button>
      ),
    },
  ];

  const hostColumns: Column<Host>[] = [
    {
      key: "remark",
      title: "Host",
      render: (h) => (
        <div>
          <div className="strong">{h.remark}</div>
          <div className="muted small mono">
            {h.address}:{h.port}
          </div>
        </div>
      ),
    },
    { key: "inbound", title: "Inbound", render: (h) => <span className="mono small">{h.inboundTag ?? "—"}</span> },
    { key: "node", title: "Нода", render: (h) => h.nodeName ?? "—" },
    {
      key: "reality",
      title: "pbk / sid",
      render: (h) => <span className="mono small">{`${h.pbk ? `${h.pbk.slice(0, 10)}…` : "—"} / ${h.sid ?? "—"}`}</span>,
    },
    { key: "prefix", title: "tagPrefix", render: (h) => h.tagPrefix ?? "—" },
    {
      key: "state",
      title: "Состояние",
      render: (h) =>
        h.isDisabled ? (
          <StatusBadge status="disabled" />
        ) : h.isHidden ? (
          <StatusBadge status="unknown" label="скрыт" />
        ) : (
          <StatusBadge status="active" />
        ),
    },
    { key: "channels", title: "Каналов", align: "right", render: (h) => h.channelCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (h) => (
        <button type="button" className="btn btn-sm" onClick={() => setHostForm({ kind: "edit", row: h })}>
          Изменить
        </button>
      ),
    },
  ];

  const squadColumns: Column<Squad>[] = [
    { key: "name", title: "Squad", render: (s) => <span className="strong">{s.name}</span> },
    {
      key: "inbounds",
      title: "Inbound'ы",
      render: (s) =>
        s.inbounds.length === 0 ? (
          <span className="muted">пусто</span>
        ) : (
          <span className="mono small">{s.inbounds.map((i) => i.tag).join(", ")}</span>
        ),
    },
    { key: "subs", title: "Подписок", align: "right", render: (s) => s.subscriptionCount },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (s) => (
        <button type="button" className="btn btn-sm" onClick={() => setSquadForm({ kind: "edit", row: s })}>
          Изменить
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Инфраструктура</h1>
        <div className="row-actions">
          <div className="seg">
            <button
              type="button"
              className={`btn btn-sm ${mode === "simple" ? "btn-primary" : ""}`}
              onClick={() => switchMode("simple")}
            >
              Простой
            </button>
            <button
              type="button"
              className={`btn btn-sm ${mode === "advanced" ? "btn-primary" : ""}`}
              onClick={() => switchMode("advanced")}
            >
              Продвинутый
            </button>
          </div>
          <button type="button" className="btn" onClick={page.reload}>
            Обновить
          </button>
        </div>
      </div>

      {notice && <div className="notice">{notice}</div>}

      {mode === "simple" && (
        <SimpleInfra
          nodes={nodes}
          inbounds={inbounds}
          onAdd={() => setWizardOpen(true)}
          onEnroll={(n) => setEnrollTarget(n)}
        />
      )}

      {mode === "advanced" && (
        <>
      <Card
        title="Серверы"
        subtitle="Физические VPS. Доступ — пароль/ключ (шифруются в БД) или ссылка на vault."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setServerForm({ kind: "create" })}>
            Добавить сервер
          </button>
        }
      >
        {servers.length === 0 ? (
          <EmptyState text="Серверов нет" hint="С сервера начинается любая нода." />
        ) : (
          <Table columns={serverColumns} rows={servers} rowKey={(s) => s.id} />
        )}
      </Card>

      <Card
        title="Config-профили"
        subtitle="Набор inbound'ов ноды. Профиль занимает ровно одна нода: Reality-ключи живут на inbound'ах профиля."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setProfileForm({ kind: "create" })}>
            Добавить профиль
          </button>
        }
      >
        {profiles.length === 0 ? (
          <EmptyState text="Профилей нет" hint="Профиль нужен, чтобы завести ноду." />
        ) : (
          <Table columns={profileColumns} rows={profiles} rowKey={(p) => p.id} />
        )}
      </Card>

      <Card
        title="Inbound'ы"
        subtitle="Правка порта или транспорта сразу пересобирает desired-state ноды профиля."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={profiles.length === 0}
            onClick={() => setInboundForm({ kind: "create" })}
          >
            Добавить inbound
          </button>
        }
      >
        {inbounds.length === 0 ? (
          <EmptyState text="Inbound'ов нет" hint="Без inbound'а нода поднимется пустой." />
        ) : (
          <Table columns={inboundColumns} rows={inbounds} rowKey={(i) => i.id} />
        )}
      </Card>

      <Card
        title="Host'ы"
        subtitle="Endpoint'ы для клиента. Отсюда генератор подписки берёт адрес, pbk и sid — правка видна в следующей выдаче."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={inbounds.length === 0 || nodes.length === 0}
            onClick={() => setHostForm({ kind: "create" })}
          >
            Добавить host
          </button>
        }
      >
        {hosts.length === 0 ? (
          <EmptyState text="Host'ов нет" hint="Host привязывает inbound к конкретному адресу и ноде." />
        ) : (
          <Table columns={hostColumns} rows={hosts} rowKey={(h) => h.id} />
        )}
      </Card>

      <Card
        title="Squad'ы"
        subtitle="Access-control: какие inbound'ы получает подписка. Правка состава меняет список клиентов на ноде."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setSquadForm({ kind: "create" })}>
            Добавить squad
          </button>
        }
      >
        {squads.length === 0 ? (
          <EmptyState text="Squad'ов нет" hint="Squad связывает подписки с inbound'ами нод." />
        ) : (
          <Table columns={squadColumns} rows={squads} rowKey={(s) => s.id} />
        )}
      </Card>
        </>
      )}

      {wizardOpen && (
        <LocationWizard
          squads={squads}
          inbounds={inbounds}
          onClose={() => setWizardOpen(false)}
          onProvisioned={(msg) => {
            setNotice(msg);
            page.reload();
          }}
          onEnroll={(n) => setEnrollTarget(n)}
        />
      )}
      {enrollTarget && (
        <AgentEnrollModal node={enrollTarget} onClose={() => setEnrollTarget(null)} />
      )}

      {serverForm && (
        <ServerModal
          row={serverForm.kind === "edit" ? serverForm.row : undefined}
          onClose={() => setServerForm(null)}
          onSaved={done(() => setServerForm(null))}
        />
      )}
      {profileForm && (
        <ProfileModal
          row={profileForm.kind === "edit" ? profileForm.row : undefined}
          onClose={() => setProfileForm(null)}
          onSaved={done(() => setProfileForm(null))}
        />
      )}
      {inboundForm && (
        <InboundModal
          row={inboundForm.kind === "edit" ? inboundForm.row : undefined}
          profiles={profiles}
          onClose={() => setInboundForm(null)}
          onSaved={done(() => setInboundForm(null))}
        />
      )}
      {hostForm && (
        <HostModal
          row={hostForm.kind === "edit" ? hostForm.row : undefined}
          inbounds={inbounds}
          nodes={nodes}
          onClose={() => setHostForm(null)}
          onSaved={done(() => setHostForm(null))}
        />
      )}
      {squadForm && (
        <SquadModal
          row={squadForm.kind === "edit" ? squadForm.row : undefined}
          inbounds={inbounds}
          onClose={() => setSquadForm(null)}
          onSaved={done(() => setSquadForm(null))}
        />
      )}
    </>
  );
}

/** Пересборка — единственный видимый признак, что правка доехала до ноды. */
function describeRebuild(rebuilt?: RebuildInfo[]): string | null {
  if (!rebuilt || rebuilt.length === 0) return "Сохранено. Конфиг нод не затронут.";
  const changed = rebuilt.filter((r) => r.changed);
  if (changed.length === 0) return "Сохранено. Конфиг нод не изменился — версия не поднималась.";
  return `Сохранено. Пересобраны: ${changed.map((r) => `${r.name} → v${r.version}`).join(", ")}`;
}

type SavedHandler = (rebuilt?: RebuildInfo[]) => void;

interface FormShellProps {
  title: string;
  editing: boolean;
  onClose: () => void;
  onSubmit: () => Promise<RebuildInfo[] | undefined>;
  onDelete?: () => Promise<RebuildInfo[] | undefined>;
  deleteHint?: string;
  onSaved: SavedHandler;
  children: ReactNode;
}

/**
 * Общая обвязка форм раздела: сохранение, удаление и показ ошибки сервера.
 * Тексты валидации приходят с бэкенда — дублировать проверки на клиенте значит
 * заводить второй, расходящийся набор правил.
 */
function FormShell({ title, editing, onClose, onSubmit, onDelete, deleteHint, onSaved, children }: FormShellProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<RebuildInfo[] | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await action());
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          {editing && onDelete && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                if (window.confirm(deleteHint ?? "Удалить запись?")) void run(onDelete);
              }}
            >
              Удалить
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(onSubmit)}>
            {busy ? "Сохраняем…" : editing ? "Сохранить" : "Создать"}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/** Пустая строка = «не задано» (null в БД), а не пустое значение. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function toInt(value: string, fallback = 0): number {
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : fallback;
}

function ServerModal({ row, onClose, onSaved }: { row?: Server; onClose: () => void; onSaved: SavedHandler }) {
  const [hostname, setHostname] = useState(row?.hostname ?? "");
  const [primaryIp, setPrimaryIp] = useState(row?.primaryIp ?? "");
  const [extraIps, setExtraIps] = useState((row?.extraIps ?? []).join(", "));
  const [country, setCountry] = useState(row?.country ?? "");
  const [authType, setAuthType] = useState<SshAuthType>(row?.sshAuthType ?? "vault_ref");
  const [sshUser, setSshUser] = useState(row?.sshUser ?? "");
  const [sshPort, setSshPort] = useState(row?.sshPort != null ? String(row.sshPort) : "");
  const [sshRef, setSshRef] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");

  const secretHint = row?.hasSshSecret ? "задан; пустое поле не меняет" : undefined;

  return (
    <FormShell
      title={row ? `Сервер ${row.hostname}` : "Новый сервер"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить сервер? Сработает, только если на нём нет нод."
      onDelete={row ? async () => void (await deleteServer(row.id)) : undefined}
      onSubmit={async () => {
        // Секреты: пустое поле при правке ничего не меняет (значение мы не показываем).
        const secret =
          authType === "vault_ref"
            ? {}
            : {
                sshUser: orNull(sshUser),
                sshPort: sshPort.trim() ? Number(sshPort) : null,
                ...(sshPassword ? { sshPassword } : {}),
                ...(sshPrivateKey ? { sshPrivateKey } : {}),
                ...(sshPassphrase ? { sshPassphrase } : {}),
              };
        const body = {
          hostname: hostname.trim(),
          primaryIp: primaryIp.trim(),
          extraIps: toList(extraIps),
          country: orNull(country),
          sshAuthType: authType,
          ...(authType === "vault_ref" && sshRef.trim() ? { sshRef: sshRef.trim() } : {}),
          ...secret,
        };
        if (row) await updateServer(row.id, body);
        else await createServer(body);
        return undefined;
      }}
    >
      <div className="grid-2">
        <Field label="Hostname" required hint="доменное имя сервера">
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="de1.example.com" />
        </Field>
        <Field label="Страна" hint="код: DE, FI, RU">
          <input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={8} placeholder="DE" />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Основной IP" required>
          <input value={primaryIp} onChange={(e) => setPrimaryIp(e.target.value)} placeholder="203.0.113.10" />
        </Field>
        <Field label="Дополнительные IP" hint="через запятую">
          <input value={extraIps} onChange={(e) => setExtraIps(e.target.value)} placeholder="203.0.113.11" />
        </Field>
      </div>

      <h3 className="form-section">SSH-доступ</h3>
      <Field label="Способ" hint="пароль и ключ шифруются в БД; vault — только ссылка, платформа по ней не ходит">
        <select value={authType} onChange={(e) => setAuthType(e.target.value as SshAuthType)}>
          <option value="vault_ref">Ссылка на vault</option>
          <option value="password">Пароль</option>
          <option value="key">Приватный ключ</option>
        </select>
      </Field>

      {authType === "vault_ref" ? (
        <Field
          label="Ссылка на SSH-доступ в vault"
          hint={row?.hasSshRef ? "ссылка задана; пустое поле её не меняет" : "именно ссылка, не ключ"}
        >
          <input value={sshRef} onChange={(e) => setSshRef(e.target.value)} placeholder="vault://projects/vpn/ssh/de1" />
        </Field>
      ) : (
        <>
          <div className="grid-2">
            <Field label="SSH-пользователь" hint="по умолчанию root">
              <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="root" />
            </Field>
            <Field label="SSH-порт" hint="по умолчанию 22">
              <input value={sshPort} onChange={(e) => setSshPort(e.target.value)} inputMode="numeric" placeholder="22" />
            </Field>
          </div>
          {authType === "password" ? (
            <Field label="Пароль" hint={secretHint}>
              <input
                type="password"
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                autoComplete="new-password"
                placeholder={row?.hasSshSecret ? "••••••••" : ""}
              />
            </Field>
          ) : (
            <>
              <Field label="Приватный ключ" hint={secretHint ?? "PEM-формат (OpenSSH / RSA)"}>
                <textarea
                  value={sshPrivateKey}
                  onChange={(e) => setSshPrivateKey(e.target.value)}
                  rows={6}
                  className="mono"
                  placeholder={row?.hasSshSecret ? "ключ задан; вставьте новый, чтобы заменить" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
                />
              </Field>
              <Field label="Passphrase ключа" hint="если ключ без пароля — оставьте пустым">
                <input
                  type="password"
                  value={sshPassphrase}
                  onChange={(e) => setSshPassphrase(e.target.value)}
                  autoComplete="new-password"
                  placeholder={row?.hasSshSecret ? "••••••••" : ""}
                />
              </Field>
            </>
          )}
        </>
      )}
    </FormShell>
  );
}

interface CheckState {
  pending: boolean;
  ok?: boolean;
  detail?: string;
}

const SSH_AUTH_LABEL: Record<SshAuthType, string> = {
  password: "пароль",
  key: "ключ",
  vault_ref: "vault",
};

function ServerSshCell({ server, check, onCheck }: { server: Server; check?: CheckState; onCheck: () => void }) {
  const configured = server.sshAuthType !== "vault_ref" ? server.hasSshSecret : server.hasSshRef;

  return (
    <div>
      <div className="small">
        <span className={configured ? "ok" : "muted"}>{SSH_AUTH_LABEL[server.sshAuthType]}</span>
        {server.sshAuthType !== "vault_ref" && server.sshUser && (
          <span className="muted mono"> {server.sshUser}@{server.primaryIp}:{server.sshPort ?? 22}</span>
        )}
      </div>
      <div>
        <SshCheckStatus server={server} check={check} />
      </div>
      {server.sshAuthType !== "vault_ref" && (
        <button type="button" className="btn btn-sm" onClick={onCheck} disabled={check?.pending}>
          {check?.pending ? "Проверка…" : "Проверить связь"}
        </button>
      )}
    </div>
  );
}

function SshCheckStatus({ server, check }: { server: Server; check?: CheckState }) {
  if (check && !check.pending) {
    return <span className={`small ${check.ok ? "ok" : "err"}`}>{check.ok ? "связь есть" : check.detail}</span>;
  }
  if (server.sshLastCheckOk === true) return <span className="small ok">связь была</span>;
  if (server.sshLastCheckOk === false) {
    return <span className="small err">{server.sshLastCheckError ?? "нет связи"}</span>;
  }
  return null;
}

function ProfileModal({ row, onClose, onSaved }: { row?: ConfigProfile; onClose: () => void; onSaved: SavedHandler }) {
  const [name, setName] = useState(row?.name ?? "");

  return (
    <FormShell
      title={row ? `Профиль «${row.name}»` : "Новый config-профиль"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить профиль? Сработает, только если на нём нет ноды и inbound'ов."
      onDelete={row ? async () => void (await deleteConfigProfile(row.id)) : undefined}
      onSubmit={async () => {
        if (row) return (await updateConfigProfile(row.id, { name: name.trim() })).rebuilt;
        await createConfigProfile({ name: name.trim() });
        return undefined;
      }}
    >
      <Field label="Название" required hint="под одну ноду: DE-exit, RU2-relay">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="de1-exit" />
      </Field>
      {row?.nodeName && <p className="muted small">Профиль занят нодой «{row.nodeName}».</p>}
    </FormShell>
  );
}

function InboundModal({
  row,
  profiles,
  onClose,
  onSaved,
}: {
  row?: Inbound;
  profiles: ConfigProfile[];
  onClose: () => void;
  onSaved: SavedHandler;
}) {
  const [configProfileId, setConfigProfileId] = useState(row?.configProfileId ?? profiles[0]?.id ?? "");
  const [tag, setTag] = useState(row?.tag ?? "");
  const [port, setPort] = useState(String(row?.port ?? 443));
  const [network, setNetwork] = useState(row?.network ?? "tcp");
  const [flow, setFlow] = useState(row?.flow ?? "xtls-rprx-vision");
  const [sni, setSni] = useState(row?.sni ?? "");
  const [fingerprint, setFingerprint] = useState(row?.fingerprint ?? "firefox");
  const [shortIds, setShortIds] = useState((row?.shortIds ?? []).join(", "));
  const [privkeyRef, setPrivkeyRef] = useState("");

  return (
    <FormShell
      title={row ? `Inbound ${row.tag}` : "Новый inbound"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить inbound? Сработает, только если его не держат squad, host или каскад."
      onDelete={row ? async () => (await deleteInbound(row.id)).rebuilt : undefined}
      onSubmit={async () => {
        const common = {
          tag: tag.trim(),
          port: toInt(port, 0),
          network,
          flow,
          sni: orNull(sni),
          fingerprint,
          shortIds: toList(shortIds),
          ...(privkeyRef.trim() ? { realityPrivkeyRef: privkeyRef.trim() } : {}),
        };
        if (row) return (await updateInbound(row.id, common)).rebuilt;
        return (await createInbound({ configProfileId, ...common })).rebuilt;
      }}
    >
      <Field label="Config-профиль" required hint={row ? "профиль inbound'а не меняется" : "профиль ноды, которой он принадлежит"}>
        <select value={configProfileId} onChange={(e) => setConfigProfileId(e.target.value)} disabled={Boolean(row)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.nodeName ? ` (${p.nodeName})` : ""}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        <Field label="Тег" required hint="буквы, цифры, . _ - ; на него ссылаются каскады">
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="VLESS_REALITY_DE" />
        </Field>
        <Field label="Порт" required>
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Транспорт">
          <select value={network} onChange={(e) => setNetwork(e.target.value)}>
            {INBOUND_NETWORKS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Flow" hint="vision работает только на tcp">
          <select value={flow} onChange={(e) => setFlow(e.target.value)}>
            {INBOUND_FLOWS.map((f) => (
              <option key={f || "none"} value={f}>
                {f || "без flow"}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="SNI" required hint="обязателен для reality">
          <input value={sni} onChange={(e) => setSni(e.target.value)} placeholder="ads.x5.ru" />
        </Field>
        <Field label="Fingerprint">
          <select value={fingerprint} onChange={(e) => setFingerprint(e.target.value)}>
            {FINGERPRINTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="shortIds" hint="hex чётной длины, через запятую; обычно приезжают с ноды при энроллменте">
        <input value={shortIds} onChange={(e) => setShortIds(e.target.value)} placeholder="aa01, bb02" />
      </Field>

      <Field
        label="Ссылка на приватник Reality в vault"
        hint={
          row?.hasRealityPrivkeyRef
            ? "ссылка задана; пустое поле её не меняет"
            : "приватник живёт на ноде, в БД только ссылка"
        }
      >
        <input value={privkeyRef} onChange={(e) => setPrivkeyRef(e.target.value)} placeholder="vault://…" />
      </Field>

      {row && !row.realityPublicKey && (
        <p className="muted small">
          Публичного ключа ещё нет: он приезжает с ноды при энроллменте агента и тогда же попадает в host'ы этой ноды.
        </p>
      )}
    </FormShell>
  );
}

function HostModal({
  row,
  inbounds,
  nodes,
  onClose,
  onSaved,
}: {
  row?: Host;
  inbounds: Inbound[];
  nodes: Node[];
  onClose: () => void;
  onSaved: SavedHandler;
}) {
  const [inboundId, setInboundId] = useState(row?.inboundId ?? inbounds[0]?.id ?? "");
  const [nodeId, setNodeId] = useState(row?.nodeId ?? nodes[0]?.id ?? "");
  const [remark, setRemark] = useState(row?.remark ?? "");
  const [address, setAddress] = useState(row?.address ?? "");
  const [port, setPort] = useState(String(row?.port ?? 443));
  const [sni, setSni] = useState(row?.sni ?? "");
  const [fingerprint, setFingerprint] = useState(row?.fingerprint ?? "firefox");
  const [pbk, setPbk] = useState(row?.pbk ?? "");
  const [sid, setSid] = useState(row?.sid ?? "");
  const [flow, setFlow] = useState(row?.flow ?? "xtls-rprx-vision");
  const [tagPrefix, setTagPrefix] = useState(row?.tagPrefix ?? "");
  const [isHidden, setIsHidden] = useState(row?.isHidden ?? false);
  const [isDisabled, setIsDisabled] = useState(row?.isDisabled ?? false);
  const [sortOrder, setSortOrder] = useState(String(row?.sortOrder ?? 0));

  return (
    <FormShell
      title={row ? `Host «${row.remark}»` : "Новый host"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить host? Сработает, только если на него не ссылается канал подписки."
      onDelete={row ? async () => (await deleteHost(row.id)).rebuilt : undefined}
      onSubmit={async () => {
        const body = {
          inboundId,
          nodeId,
          remark: remark.trim(),
          address: address.trim(),
          port: toInt(port, 0),
          sni: orNull(sni),
          fingerprint,
          pbk: orNull(pbk),
          sid: orNull(sid),
          flow,
          tagPrefix: orNull(tagPrefix),
          isHidden,
          isDisabled,
          sortOrder: toInt(sortOrder),
        };
        if (row) return (await updateHost(row.id, body)).rebuilt;
        return (await createHost(body)).rebuilt;
      }}
    >
      <div className="grid-2">
        <Field label="Inbound" required>
          <select value={inboundId} onChange={(e) => setInboundId(e.target.value)}>
            {inbounds.map((i) => (
              <option key={i.id} value={i.id}>
                {i.tag}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Нода" required hint="чью Reality-личность обслуживает этот адрес">
          <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Название" required hint="видно оператору, не клиенту">
          <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="DE direct" />
        </Field>
        <Field label="tagPrefix" hint="front — если это RU-front для client-chain">
          <input value={tagPrefix} onChange={(e) => setTagPrefix(e.target.value)} placeholder="" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Адрес" required hint="IP или домен">
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.10" />
        </Field>
        <Field label="Порт" required>
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="SNI">
          <input value={sni} onChange={(e) => setSni(e.target.value)} placeholder="ads.x5.ru" />
        </Field>
        <Field label="Fingerprint">
          <select value={fingerprint} onChange={(e) => setFingerprint(e.target.value)}>
            {FINGERPRINTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="pbk" hint="перезапишется при энроллменте ноды">
          <input value={pbk} onChange={(e) => setPbk(e.target.value)} />
        </Field>
        <Field label="sid" hint="один из shortIds инбаунда">
          <input value={sid} onChange={(e) => setSid(e.target.value)} placeholder="aa01" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Flow">
          <select value={flow} onChange={(e) => setFlow(e.target.value)}>
            {INBOUND_FLOWS.map((f) => (
              <option key={f || "none"} value={f}>
                {f || "без flow"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Порядок" hint="меньше — выше в выдаче">
          <input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Выключен" hint="выключенный host исчезает из подписки">
          <Toggle checked={isDisabled} onChange={setIsDisabled} label={isDisabled ? "да" : "нет"} />
        </Field>
        <Field label="Скрыт" hint="скрытый тоже не попадает в выдачу">
          <Toggle checked={isHidden} onChange={setIsHidden} label={isHidden ? "да" : "нет"} />
        </Field>
      </div>
    </FormShell>
  );
}

function SquadModal({
  row,
  inbounds,
  onClose,
  onSaved,
}: {
  row?: Squad;
  inbounds: Inbound[];
  onClose: () => void;
  onSaved: SavedHandler;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [selected, setSelected] = useState<string[]>((row?.inbounds ?? []).map((i) => i.id));

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  return (
    <FormShell
      title={row ? `Squad «${row.name}»` : "Новый squad"}
      editing={Boolean(row)}
      onClose={onClose}
      onSaved={onSaved}
      deleteHint="Удалить squad? Сработает, только если к нему не привязаны подписки и тарифы."
      onDelete={row ? async () => (await deleteSquad(row.id)).rebuilt : undefined}
      onSubmit={async () => {
        const body = { name: name.trim(), inboundIds: selected };
        if (row) return (await updateSquad(row.id, body)).rebuilt;
        return (await createSquad(body)).rebuilt;
      }}
    >
      <Field label="Название" required>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Базовый доступ" />
      </Field>

      <h3 className="form-section">Inbound'ы</h3>
      {inbounds.length === 0 ? (
        <p className="muted small">Inbound'ов пока нет — привязывать нечего.</p>
      ) : (
        <div className="checks">
          {inbounds.map((i) => (
            <label key={i.id} className="check">
              <input
                type="checkbox"
                checked={selected.includes(i.id)}
                onChange={(e) => toggle(i.id, e.target.checked)}
              />
              <span className="mono">{i.tag}</span>
              <span className="muted small">{i.nodeName ?? "нода не заведена"}</span>
            </label>
          ))}
        </div>
      )}
      <p className="muted small">
        Набор заменяется целиком: снятая галочка убирает подписчиков squad'а с этого inbound'а на ноде.
      </p>
    </FormShell>
  );
}

// --- простой режим ----------------------------------------------------------

/**
 * Простой режим: одна локация = одна нода, без пяти таблиц. Показывает список
 * локаций со статусом и мастер, который заводит всю цепочку за один экран.
 */
function SimpleInfra({
  nodes,
  inbounds,
  onAdd,
  onEnroll,
}: {
  nodes: Node[];
  inbounds: Inbound[];
  onAdd: () => void;
  onEnroll: (n: { id: string; name: string }) => void;
}) {
  // первый inbound ноды: в простом режиме на ноду заводится ровно один
  const inboundByNode = new Map<string, Inbound>();
  for (const i of inbounds) if (i.nodeId && !inboundByNode.has(i.nodeId)) inboundByNode.set(i.nodeId, i);

  const columns: Column<Node>[] = [
    {
      key: "name",
      title: "Локация",
      render: (n) => (
        <div>
          <div className="strong">{n.name}</div>
          <div className="muted small mono">
            {n.serverHostname ?? n.address ?? "—"}
            {n.country ? ` · ${n.country}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "state",
      title: "Состояние",
      render: (n) => {
        const s = locationState(n, inboundByNode.get(n.id));
        return <StatusBadge status="loc" tone={s.tone} label={s.label} />;
      },
    },
    {
      key: "inbound",
      title: "Вход",
      render: (n) => inboundByNode.get(n.id)?.tag ?? <span className="muted">нет</span>,
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (n) => (
        <button type="button" className="btn btn-sm" onClick={() => onEnroll({ id: n.id, name: n.name })}>
          Токен агента
        </button>
      ),
    },
  ];

  return (
    <>
      <Card
        title="Как это работает"
        subtitle="Локация = сервер с одной нодой. Мастер сам заведёт сервер, ноду, вход (inbound) и endpoint — вместо пяти форм."
      >
        <ol className="steps">
          <li>«Добавить локацию» → имя, IP сервера и домен-маскировку (SNI).</li>
          <li>Отметьте, в какие squad'ы (наборы доступа) выдавать — или пропустите.</li>
          <li>Выпустите токен агента и поставьте агента на сервер: он сам заберёт конфиг и пришлёт ключи.</li>
        </ol>
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            Добавить локацию
          </button>
        </div>
      </Card>

      <Card title="Локации" subtitle="Ноды сети. «Работает» — агент применил актуальный конфиг.">
        {nodes.length === 0 ? (
          <EmptyState text="Локаций нет" hint="Нажмите «Добавить локацию» выше." />
        ) : (
          <Table columns={columns} rows={nodes} rowKey={(n) => n.id} />
        )}
      </Card>
    </>
  );
}

/** Состояние локации в терминах оператора, без деталей про хеши конфига. */
function locationState(n: Node, inbound?: Inbound): { tone: "ok" | "warn" | "muted"; label: string } {
  if (!inbound) return { tone: "muted", label: "нет входа" };
  // pbk пустой или нет ни одного heartbeat — агента ещё не поставили/не энроллили
  if (!inbound.realityPublicKey || !n.lastHeartbeatAt) return { tone: "warn", label: "ждёт агента" };
  if (n.converged) return { tone: "ok", label: `работает, v${n.desiredVersion ?? 0}` };
  return { tone: "warn", label: "не сошёлся" };
}

/** Самый частый SNI в уже заведённых inbound'ах — разумный дефолт для новой локации. */
function commonSni(inbounds: Inbound[]): string {
  const counts = new Map<string, number>();
  for (const i of inbounds) if (i.sni) counts.set(i.sni, (counts.get(i.sni) ?? 0) + 1);
  let best = "";
  let bestN = 0;
  for (const [sni, n] of counts) {
    if (n > bestN) {
      best = sni;
      bestN = n;
    }
  }
  return best;
}

// --- мастер «Добавить локацию» ----------------------------------------------

function LocationWizard({
  squads,
  inbounds,
  onClose,
  onProvisioned,
  onEnroll,
}: {
  squads: Squad[];
  inbounds: Inbound[];
  onClose: () => void;
  onProvisioned: (msg: string) => void;
  onEnroll: (n: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [primaryIp, setPrimaryIp] = useState("");
  const [country, setCountry] = useState("");
  const [sni, setSni] = useState(() => commonSni(inbounds));
  const [port, setPort] = useState("443");
  const [selectedSquads, setSelectedSquads] = useState<string[]>([]);
  // продвинутое — под <details>, с дефолтами общего случая
  const [hostname, setHostname] = useState("");
  const [tag, setTag] = useState("");
  const [roles, setRoles] = useState<string[]>(["exit"]);
  const [fingerprint, setFingerprint] = useState("firefox");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  const toggleSquad = (id: string, on: boolean) =>
    setSelectedSquads((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  const toggleRole = (role: string, on: boolean) =>
    setRoles((prev) => (on ? [...new Set([...prev, role])] : prev.filter((r) => r !== role)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await provisionLocation({
        name: name.trim(),
        primaryIp: primaryIp.trim(),
        sni: sni.trim(),
        country: country.trim() || undefined,
        port: Number(port) || undefined,
        hostname: hostname.trim() || undefined,
        tag: tag.trim() || undefined,
        roles,
        fingerprint,
        squadIds: selectedSquads,
      });
      setResult(res);
      onProvisioned(describeProvision(res));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal
        title="Локация заведена"
        onClose={onClose}
        footer={
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onEnroll({ id: result.node.id, name: result.node.label });
                onClose();
              }}
            >
              Выпустить токен агента
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Закрыть
            </button>
          </>
        }
      >
        <ul className="provision-summary">
          <li>{refLine("Сервер", result.server)}</li>
          <li>{refLine("Профиль", result.configProfile)}</li>
          <li>{refLine("Нода", result.node)}</li>
          <li>{refLine("Вход (inbound)", result.inbound)}</li>
          <li>{refLine("Endpoint (host)", result.host)}</li>
        </ul>
        {result.squads.length > 0 && (
          <p className="small">Выдаётся в squad'ах: {result.squads.map((s) => s.name).join(", ")}.</p>
        )}
        <p className="muted small">
          Reality-ключи проставятся автоматически после энроллмента агента — до этого вход помечен «ждёт агента».
        </p>
      </Modal>
    );
  }

  const disabled = busy || !name.trim() || !primaryIp.trim() || !sni.trim();

  return (
    <Modal
      title="Добавить локацию"
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void submit()}>
            {busy ? "Заводим…" : "Создать"}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Название" required hint="напр. de1-exit — станет именем ноды">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="de1-exit" />
        </Field>
        <Field label="Страна" hint="код: DE, FI, NL">
          <input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={8} placeholder="DE" />
        </Field>
      </div>
      <div className="grid-2">
        <Field label="IP сервера" required>
          <input value={primaryIp} onChange={(e) => setPrimaryIp(e.target.value)} placeholder="203.0.113.10" />
        </Field>
        <Field label="Порт" hint="обычно 443">
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </Field>
      </div>
      <Field
        label="Домен-маскировка (SNI)"
        required
        hint="под какой сайт маскируется Reality: крупный домен с TLS 1.3, который не заблокирован"
      >
        <input value={sni} onChange={(e) => setSni(e.target.value)} placeholder="ads.x5.ru" />
      </Field>

      <h3 className="form-section">Выдавать в squad'ах</h3>
      {squads.length === 0 ? (
        <p className="muted small">Squad'ов пока нет — можно завести локацию сейчас и выдать её позже.</p>
      ) : (
        <div className="checks">
          {squads.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={selectedSquads.includes(s.id)}
                onChange={(e) => toggleSquad(s.id, e.target.checked)}
              />
              <span>{s.name}</span>
            </label>
          ))}
        </div>
      )}

      <details className="advanced">
        <summary>Продвинутые параметры</summary>
        <div className="grid-2">
          <Field label="Домен/hostname сервера" hint="по умолчанию = IP">
            <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="по умолчанию IP" />
          </Field>
          <Field label="Тег входа" hint="по умолчанию VLESS_REALITY_<ИМЯ>">
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="авто" />
          </Field>
        </div>
        <Field label="Fingerprint" hint="uTLS-отпечаток клиента">
          <select value={fingerprint} onChange={(e) => setFingerprint(e.target.value)}>
            {FINGERPRINTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Роли" hint="по умолчанию exit">
          <div className="checks">
            {NODE_ROLES.map((role) => (
              <label key={role} className="check">
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={(e) => toggleRole(role, e.target.checked)}
                />
                <span>{role}</span>
              </label>
            ))}
          </div>
        </Field>
      </details>
    </Modal>
  );
}

/** Строка сводки: что именно завелось (или уже было) в цепочке. */
function refLine(label: string, ref: ProvisionResult["server"]): ReactNode {
  return (
    <>
      <span className="muted">{label}:</span> <span className="mono">{ref.label}</span>{" "}
      <span className={ref.created ? "ok small" : "muted small"}>{ref.created ? "создан" : "уже был"}</span>
    </>
  );
}

function describeProvision(res: ProvisionResult): string {
  const created = [
    res.server.created && "сервер",
    res.node.created && "нода",
    res.inbound.created && "вход",
    res.host.created && "endpoint",
  ].filter(Boolean);
  if (created.length === 0) return `Локация «${res.node.label}» уже была — состав не изменился.`;
  return `Локация «${res.node.label}»: заведено — ${created.join(", ")}. Дальше выпустите токен агента.`;
}

// --- энроллмент из простого режима ------------------------------------------

/**
 * Bootstrap-токен показывается один раз (в БД лежит только хеш), поэтому окно не
 * закрывается автоматически. Та же ручка, что и на странице «Ноды и каскады».
 */
function AgentEnrollModal({ node, onClose }: { node: { id: string; name: string }; onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await issueEnrollment(node.id);
      setToken(res.bootstrapToken);
      setExpiresAt(res.bootstrapExpiresAt);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Токен агента · ${node.name}`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Закрыть
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void issue()}>
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
          Выпуск даёт одноразовый токен: агент на сервере обменяет его на постоянный и заберёт конфиг. Прежний
          невыпущенный токен этой ноды перестанет действовать.
        </p>
      )}
    </Modal>
  );
}

