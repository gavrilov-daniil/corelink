import { useState, type FormEvent } from "react";
import {
  ADMIN_ROLES,
  approveOperator,
  createOperator,
  errorMessage,
  getOperators,
  getTelegramSettings,
  MIN_PASSWORD_LENGTH,
  ROLE_HINTS,
  ROLE_LABELS,
  setOperatorPassword,
  unlinkOperatorTelegram,
  updateOperator,
  updateTelegramSettings,
  type AdminRole,
  type Operator,
  type TelegramSettings,
} from "../api";
import { useResource } from "../useResource";
import { roleAtLeast, useSession } from "../session";
import { formatDateTime } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Modal from "../components/Modal";
import Field from "../components/Field";
import Toggle from "../components/Toggle";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

/**
 * Операторы админки: заявки из Telegram, роли, способы входа и настройка самого
 * входа по Telegram. Экран для admin и выше — саппорт сюда не ходит.
 */
export default function AccessPage() {
  const { me } = useSession();
  const operators = useResource(getOperators);
  // Настройки грузятся здесь, а не внутри карточки: иначе их запрос ждал бы список операторов.
  const telegramSettings = useResource(getTelegramSettings);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [passwordFor, setPasswordFor] = useState<Operator | null>(null);

  const assignable = ADMIN_ROLES.filter((role) => roleAtLeast(me.role, role));

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      operators.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  if (operators.loading) return <Loading />;
  if (operators.error) return <ErrorBox error={operators.error} onRetry={operators.reload} />;
  if (!operators.data) return null;

  const pending = operators.data.filter((o) => o.status === "pending");
  const known = operators.data.filter((o) => o.status !== "pending");

  const columns: Column<Operator>[] = [
    {
      key: "who",
      title: "Оператор",
      render: (o) => (
        <div>
          <div className="strong">{o.displayName ?? o.email ?? "без имени"}</div>
          <div className="muted small">
            {[o.email, o.telegramUsername ? `@${o.telegramUsername}` : null].filter(Boolean).join(" · ") || "—"}
            {o.id === me.operatorId && " · это вы"}
          </div>
        </div>
      ),
    },
    {
      key: "role",
      title: "Роль",
      render: (o) => (
        <select
          value={o.role}
          disabled={busyId === o.id || o.id === me.operatorId || !roleAtLeast(me.role, o.role)}
          onChange={(e) => void run(o.id, () => updateOperator(o.id, { role: e.target.value as AdminRole }))}
        >
          {assignable.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
          {/* Роль выше своей показываем, но не даём выбрать — иначе строка выглядит пустой. */}
          {!assignable.includes(o.role) && <option value={o.role}>{ROLE_LABELS[o.role]}</option>}
        </select>
      ),
    },
    { key: "status", title: "Статус", render: (o) => <StatusBadge status={o.status} /> },
    {
      key: "how",
      title: "Вход",
      render: (o) => (
        <span className="small">
          {[o.hasPassword ? "пароль" : null, o.telegramId ? "telegram" : null].filter(Boolean).join(" + ") || "нет"}
        </span>
      ),
    },
    { key: "created", title: "Заведён", render: (o) => <span className="small">{formatDateTime(o.createdAt)}</span> },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (o) => (
        <div className="row-actions">
          {o.email && (
            <button type="button" className="btn btn-sm" onClick={() => setPasswordFor(o)}>
              Пароль
            </button>
          )}
          {o.telegramId && o.hasPassword && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busyId === o.id}
              onClick={() => void run(o.id, () => unlinkOperatorTelegram(o.id))}
            >
              Отвязать TG
            </button>
          )}
          {o.id !== me.operatorId &&
            (o.status === "disabled" ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busyId === o.id}
                onClick={() => void run(o.id, () => updateOperator(o.id, { status: "active" }))}
              >
                Включить
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busyId === o.id}
                onClick={() => void run(o.id, () => updateOperator(o.id, { status: "disabled" }))}
              >
                Отключить
              </button>
            ))}
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Доступ</h1>
        <button type="button" className="btn" onClick={operators.reload}>
          Обновить
        </button>
      </div>

      {error && <ErrorBox error={error} />}

      {pending.length > 0 && (
        <Card
          title={`Заявки на доступ (${pending.length})`}
          subtitle="Вошли через Telegram и ждут подтверждения. До подтверждения не видят ни одного экрана."
        >
          {pending.map((o) => (
            <PendingRow
              key={o.id}
              operator={o}
              assignable={assignable}
              busy={busyId === o.id}
              onApprove={(role) => void run(o.id, () => approveOperator(o.id, role))}
              onReject={() => void run(o.id, () => updateOperator(o.id, { status: "disabled" }))}
            />
          ))}
        </Card>
      )}

      <Card
        title={`Операторы (${known.length})`}
        subtitle="Учётку с email и паролем заводит только админ отсюда — самозаписи по почте нет."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Завести учётку
          </button>
        }
      >
        {known.length === 0 ? (
          <EmptyState text="Учёток нет" hint="Заведите первую — она и будет входить по email и паролю." />
        ) : (
          <Table columns={columns} rows={known} rowKey={(o) => o.id} />
        )}
      </Card>

      {telegramSettings.loading && <Loading />}
      {telegramSettings.error && <ErrorBox error={telegramSettings.error} onRetry={telegramSettings.reload} />}
      {telegramSettings.data && (
        // key: после сохранения форма должна перезаписаться свежими значениями,
        // а не остаться с тем, что оператор набрал до отправки
        <TelegramSettingsCard
          key={telegramSettings.data.updatedAt ?? "empty"}
          current={telegramSettings.data}
          onSaved={telegramSettings.setData}
        />
      )}

      {creating && (
        <CreateOperatorModal
          assignable={assignable}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            operators.reload();
          }}
        />
      )}
      {passwordFor && (
        <PasswordModal
          operator={passwordFor}
          onClose={() => setPasswordFor(null)}
          onSaved={() => {
            setPasswordFor(null);
            operators.reload();
          }}
        />
      )}
    </>
  );
}

function PendingRow({
  operator,
  assignable,
  busy,
  onApprove,
  onReject,
}: {
  operator: Operator;
  assignable: AdminRole[];
  busy: boolean;
  onApprove: (role: AdminRole) => void;
  onReject: () => void;
}) {
  const [role, setRole] = useState<AdminRole>("support");

  return (
    <div className="inline-form">
      <div>
        <div className="strong">{operator.displayName ?? "без имени"}</div>
        <div className="muted small">
          {operator.telegramUsername ? `@${operator.telegramUsername}` : `tg ${operator.telegramId}`} ·{" "}
          {formatDateTime(operator.createdAt)}
        </div>
      </div>
      <Field label="Роль" hint={ROLE_HINTS[role]}>
        <select value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
          {assignable.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onApprove(role)}>
        Подтвердить
      </button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={onReject}>
        Отклонить
      </button>
    </div>
  );
}

function CreateOperatorModal({
  assignable,
  onClose,
  onSaved,
}: {
  assignable: AdminRole[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminRole>("support");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createOperator({ email: email.trim(), password, role, displayName: displayName.trim() || undefined });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Новая учётка"
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !email.includes("@") || password.length < MIN_PASSWORD_LENGTH}
            onClick={(e) => void submit(e)}
          >
            {busy ? "Создаём…" : "Создать"}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="Email" required>
          <input type="email" value={email} autoFocus onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Имя" hint="Как показывать оператора в списках. Необязательно.">
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Пароль" required hint={`Минимум ${MIN_PASSWORD_LENGTH} символов. Передайте его оператору — он сменит сам.`}>
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Роль" hint={ROLE_HINTS[role]}>
          <select value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
            {assignable.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
      </form>
    </Modal>
  );
}

function PasswordModal({
  operator,
  onClose,
  onSaved,
}: {
  operator: Operator;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Пароль: ${operator.email}`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || password.length < MIN_PASSWORD_LENGTH}
            onClick={() => {
              setBusy(true);
              setError(null);
              setOperatorPassword(operator.id, password)
                .then(onSaved)
                .catch((e) => {
                  setError(errorMessage(e));
                  setBusy(false);
                });
            }}
          >
            {busy ? "Сохраняем…" : "Задать пароль"}
          </button>
        </>
      }
    >
      <p className="small muted">Все живые сессии этой учётки будут отозваны.</p>
      <Field label="Новый пароль" required hint={`Минимум ${MIN_PASSWORD_LENGTH} символов.`}>
        <input
          type="password"
          value={password}
          autoFocus
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

/**
 * Настройка Telegram Web Login. Секрет наружу не отдаётся — только признак «задан».
 * Значения берутся в BotFather: Bot Settings → Web Login.
 */
function TelegramSettingsCard({
  current,
  onSaved,
}: {
  current: TelegramSettings;
  onSaved: (next: TelegramSettings) => void;
}) {
  const [botUsername, setBotUsername] = useState(current.botUsername);
  const [clientId, setClientId] = useState(current.clientId);
  const [redirectUri, setRedirectUri] = useState(
    current.redirectUri || `${window.location.origin}/api/admin/auth/telegram/callback`,
  );
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: {
    isEnabled?: boolean;
    botUsername?: string;
    clientId?: string;
    redirectUri?: string;
    clientSecret?: string;
  }) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateTelegramSettings(patch));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Вход по Telegram"
      subtitle="Кнопка Telegram на странице входа. Незнакомый аккаунт создаёт заявку, а не доступ."
    >
      {error && <ErrorBox error={error} />}

      <div className="inline-form">
        <Toggle
          checked={current.isEnabled}
          disabled={busy}
          label={current.isEnabled ? "Включён" : "Выключен"}
          onChange={(next) => void save({ isEnabled: next })}
        />
      </div>

      <Field label="Username бота" hint="Без @. На вход не влияет — нужен, чтобы было видно, какой бот подключён.">
        <input value={botUsername} onChange={(e) => setBotUsername(e.target.value)} placeholder="corelink_ops_bot" />
      </Field>

      <div className="grid-2">
        <Field label="Client ID" hint="BotFather → Bot Settings → Web Login. Это идентификатор бота.">
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="7777777" />
        </Field>

        <Field
          label="Client secret"
          hint={
            current.hasClientSecret
              ? "Секрет задан и хранится зашифрованным. Введите новый, чтобы заменить."
              : "Выдаётся там же, рядом с Client ID. Отзывается отдельно от токена бота."
          }
        >
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={current.hasClientSecret ? "••••••••" : "секрет из BotFather"}
          />
        </Field>
      </div>

      <Field
        label="Redirect URI"
        hint="Этот же адрес добавьте в Allowed URLs у бота. Telegram сверяет его посимвольно: расхождение в схеме или пути ломает вход."
      >
        <input
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          placeholder="https://admin.example.org/api/admin/auth/telegram/callback"
        />
      </Field>

      <div className="row-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            void save({
              botUsername: botUsername.trim(),
              clientId: clientId.trim(),
              redirectUri: redirectUri.trim(),
              // Пустое поле означает «не трогать секрет»: стереть его можно, выключив вход.
              ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
            })
          }
        >
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
        <span className="muted small">Обновлено: {formatDateTime(current.updatedAt)}</span>
      </div>
    </Card>
  );
}
