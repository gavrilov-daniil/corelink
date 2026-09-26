import { useEffect, useState } from "react";
import {
  errorMessage,
  extendSubscription,
  getDevices,
  getSquads,
  getSubscribers,
  getUsage,
  grantManualSubscription,
  revokeSubscription,
  setSubscriptionEnabled,
  unlinkDevice,
  type ManualGrantResult,
  type Subscriber,
  type SubscriberDevice,
  type UsageRow,
} from "../api";
import { useResource } from "../useResource";
import { useCan } from "../session";
import { daysLeft, formatBytes, formatDateTime } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Field from "../components/Field";
import Modal from "../components/Modal";
import CopyButton from "../components/CopyButton";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

/** Имя в списке: @username у клиента бота, метка — у человека, выданного вручную. */
function displayName(s: Subscriber): string {
  if (s.username) return `@${s.username}`;
  return s.label ?? "без username";
}

export default function SubscribersPage() {
  const page = useResource(getSubscribers);
  const canGrant = useCan("admin");
  const [selected, setSelected] = useState<Subscriber | null>(null);
  const [granting, setGranting] = useState(false);
  const [query, setQuery] = useState("");

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;

  const needle = query.trim().toLowerCase();
  const rows = needle
    ? page.data.filter(
        (s) =>
          (s.username ?? "").toLowerCase().includes(needle) ||
          (s.label ?? "").toLowerCase().includes(needle) ||
          String(s.telegramId ?? "").includes(needle) ||
          s.status.includes(needle),
      )
    : page.data;

  // карточка держит свежую строку: после продления/отключения список перечитан,
  // а выбранный объект — снимок до правки
  const current = selected ? (page.data.find((s) => s.id === selected.id) ?? selected) : null;

  // Тихое обновление, не page.reload(): тот показывает «Загрузка» вместо страницы и снёс
  // бы открытую модалку вместе со ссылкой, которую оператор ещё не скопировал. Сбой здесь
  // оставляет список устаревшим до кнопки «Обновить» — сама правка уже сохранена.
  const refresh = () => {
    getSubscribers().then(page.setData, () => undefined);
  };

  const columns: Column<Subscriber>[] = [
    {
      key: "who",
      title: "Подписчик",
      render: (s) => (
        <div>
          <div className="strong">{displayName(s)}</div>
          <div className="muted small">{s.telegramId ? `tg: ${s.telegramId}` : "вручную, без бота"}</div>
        </div>
      ),
    },
    { key: "status", title: "Статус", render: (s) => <StatusBadge status={s.status} /> },
    {
      key: "expire",
      title: "Срок",
      render: (s) => {
        const left = daysLeft(s.expireAt);
        return (
          <div>
            <div>{formatDateTime(s.expireAt)}</div>
            {left !== null && (
              <div className={left < 0 ? "err small" : left <= 3 ? "warn small" : "muted small"}>
                {left < 0 ? `истекла ${-left} дн назад` : `осталось ${left} дн`}
              </div>
            )}
          </div>
        );
      },
    },
    { key: "traffic", title: "Трафик", align: "right", render: (s) => formatBytes(s.usedTrafficBytes) },
    {
      key: "devices",
      title: "Устройства",
      align: "right",
      render: (s) => {
        const limit = s.deviceLimit;
        if (limit === null) return <span>{s.devicesUsed} / без лимита</span>;
        return (
          <span className={s.devicesUsed >= limit ? "warn" : undefined}>
            {s.devicesUsed} / {limit}
          </span>
        );
      },
    },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (s) => (
        <button type="button" className="btn btn-sm" onClick={() => setSelected(s)}>
          Подробнее
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Подписчики</h1>
        <div className="row-actions">
          {canGrant && (
            <button type="button" className="btn btn-primary" onClick={() => setGranting(true)}>
              Выдать подписку
            </button>
          )}
          <button type="button" className="btn" onClick={page.reload}>
            Обновить
          </button>
        </div>
      </div>

      <Card
        title={`Подписки (${page.data.length})`}
        actions={
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="поиск по username, tg id, статусу"
          />
        }
      >
        {page.data.length === 0 ? (
          <EmptyState text="Подписчиков нет" />
        ) : rows.length === 0 ? (
          <EmptyState text="Ничего не найдено" hint="Измените запрос." />
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(s) => s.id}
            onRowClick={setSelected}
            activeKey={selected?.id ?? null}
          />
        )}
      </Card>

      {/* key: при переключении подписчика форма и загруженная статистика должны
          сброситься, иначе в карточке остаются цифры от предыдущего. */}
      {current && (
        <SubscriberDetails
          key={current.id}
          subscriber={current}
          onChanged={refresh}
          onClose={() => setSelected(null)}
        />
      )}

      {granting && (
        <ManualGrantModal subscribers={page.data} onDone={refresh} onClose={() => setGranting(false)} />
      )}
    </>
  );
}

/** Пустая строка — «без лимита» (null), иначе целое; мусор — undefined, форма его не отправит. */
function parseLimit(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Ручная выдача: новому человеку без бота (по метке) или подписчику из бота — на его
 * основную подписку, ту же ссылку, что он видит в боте.
 */
function ManualGrantModal({
  subscribers,
  onDone,
  onClose,
}: {
  subscribers: Subscriber[];
  onDone: () => void;
  onClose: () => void;
}) {
  const squads = useResource(getSquads);
  const ownSquads = (squads.data ?? []).filter((s) => !s.forAll);
  // один ключ на открытую форму: повторная отправка не заведёт второго человека
  const [requestId] = useState(() => crypto.randomUUID());
  const [target, setTarget] = useState<"new" | "bot">("new");
  const [label, setLabel] = useState("");
  const [filter, setFilter] = useState("");
  const [subscriberId, setSubscriberId] = useState("");
  const [days, setDays] = useState("30");
  const [forever, setForever] = useState(false);
  const [deviceLimit, setDeviceLimit] = useState("");
  const [trafficGb, setTrafficGb] = useState("");
  const [squadIds, setSquadIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualGrantResult | null>(null);

  // по строке на человека из бота: выдача ляжет на его основную подписку
  const botPeople = [
    ...new Map(subscribers.filter((s) => s.telegramId !== null).map((s) => [s.subscriberId, s])).values(),
  ];
  const needle = filter.trim().toLowerCase();
  const options = botPeople
    .filter((s) => !needle || (s.username ?? "").toLowerCase().includes(needle) || String(s.telegramId).includes(needle))
    .slice(0, 50);

  const pick = (id: string) => {
    setSubscriberId(id);
    // лимиты подставляем текущие: что в форме — то и будет у подписки
    const row = botPeople.find((s) => s.subscriberId === id);
    setDeviceLimit(row?.deviceLimit ? String(row.deviceLimit) : "");
    setTrafficGb(row?.trafficLimitBytes ? String(Math.round(row.trafficLimitBytes / 1024 ** 3)) : "");
  };

  const toggleSquad = (id: string, on: boolean) =>
    setSquadIds((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  const submit = async () => {
    const term = Number(days);
    const devices = parseLimit(deviceLimit);
    const traffic = parseLimit(trafficGb);
    // NaN ушёл бы в JSON как null — сервер принял бы его за «бессрочно»/«без лимита»
    if (!forever && (!Number.isInteger(term) || term < 1)) return setError("срок — целое число дней");
    if (devices === undefined) return setError("устройств — целое число или пусто");
    if (traffic === undefined) return setError("трафик — целое число ГБ или пусто");

    setBusy(true);
    setError(null);
    try {
      const res = await grantManualSubscription(
        {
          ...(target === "new" ? { label: label.trim() } : { subscriberId }),
          days: forever ? null : term,
          deviceLimit: devices,
          trafficGb: traffic,
          squadIds,
        },
        requestId,
      );
      setResult(res);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  if (result) {
    const blocked = result.status === "disabled" || result.status === "suspended";
    return (
      <Modal
        title="Подписка выдана"
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Готово
          </button>
        }
      >
        <p className="small">
          {result.expireAt ? `Действует до ${formatDateTime(result.expireAt)}.` : "Бессрочная."}{" "}
          <StatusBadge status={result.status} />
        </p>
        {blocked && (
          <p className="warn small">Подписка заблокирована — доступ появится после «Включить» в её карточке.</p>
        )}
        <Field
          label="Ссылка подписки"
          hint={target === "new" ? "отдайте человеку — он добавит её в Happ" : "та же, что клиент видит в боте"}
        >
          <div className="inline-form">
            <input readOnly value={result.subscriptionUrl} className="mono" />
            <CopyButton value={result.subscriptionUrl} />
          </div>
        </Field>
      </Modal>
    );
  }

  const disabled = busy || (target === "new" ? !label.trim() : !subscriberId);

  return (
    <Modal
      title="Выдать подписку"
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => void submit()}>
            {busy ? "Выдаём…" : "Выдать"}
          </button>
        </>
      }
    >
      <div className="seg">
        <button
          type="button"
          className={`btn btn-sm ${target === "new" ? "btn-primary" : ""}`}
          onClick={() => setTarget("new")}
        >
          Новый человек
        </button>
        <button
          type="button"
          className={`btn btn-sm ${target === "bot" ? "btn-primary" : ""}`}
          onClick={() => setTarget("bot")}
        >
          Подписчик из бота
        </button>
      </div>

      {target === "new" ? (
        <Field label="Кто это" required hint="метка в списке подписчиков: друг, тестер, партнёр">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Тестер Вася" maxLength={128} />
        </Field>
      ) : (
        <>
          <Field label="Найти" hint="по @username или tg id">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="@username или 123456789" />
          </Field>
          <Field label="Подписчик" required hint="доступ ляжет на его подписку из бота — ссылка у клиента не меняется">
            <select value={subscriberId} onChange={(e) => pick(e.target.value)}>
              <option value="">{options.length > 0 ? "— выберите —" : "никого не нашлось"}</option>
              {options.map((s) => (
                <option key={s.subscriberId} value={s.subscriberId}>
                  {displayName(s)} · tg {s.telegramId} · {s.status}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      <div className="grid-2">
        <Field label="Срок, дней" hint={target === "bot" ? "прибавится к текущему окончанию" : undefined}>
          <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" disabled={forever} />
        </Field>
        <Field label="Без срока">
          <label className="check">
            <input type="checkbox" checked={forever} onChange={(e) => setForever(e.target.checked)} />
            <span>бессрочно</span>
          </label>
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Лимит устройств" hint="пусто — без лимита">
          <input value={deviceLimit} onChange={(e) => setDeviceLimit(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Трафик, ГБ" hint="пусто — без лимита">
          <input value={trafficGb} onChange={(e) => setTrafficGb(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <Field label="Squad'ы" hint="локации общего squad'а у всех; свой squad добавляет свои">
        {ownSquads.length === 0 ? (
          <span className="muted small">Своих squad'ов нет — клиент получит локации общего.</span>
        ) : (
          <div className="checks">
            {ownSquads.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={squadIds.includes(s.id)}
                  onChange={(e) => toggleSquad(s.id, e.target.checked)}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </div>
        )}
      </Field>
    </Modal>
  );
}

function SubscriberDetails({
  subscriber,
  onChanged,
  onClose,
}: {
  subscriber: Subscriber;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [shortUuid, setShortUuid] = useState(subscriber.shortUuid);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!shortUuid.trim()) {
      setError("нужен shortUuid подписки");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setUsage(await getUsage(shortUuid.trim()));
    } catch (e) {
      setError(errorMessage(e));
      setUsage(null);
    } finally {
      setLoading(false);
    }
  };

  const columns: Column<UsageRow>[] = [
    { key: "day", title: "День", render: (r) => r.day },
    { key: "node", title: "Нода", render: (r) => <span className="mono small">{r.nodeId}</span> },
    { key: "up", title: "Отдано", align: "right", render: (r) => formatBytes(r.up) },
    { key: "down", title: "Принято", align: "right", render: (r) => formatBytes(r.down) },
    { key: "total", title: "Итого", align: "right", render: (r) => formatBytes(r.up + r.down) },
  ];

  return (
    <Card
      title={
        subscriber.username || subscriber.label ? displayName(subscriber) : `tg ${subscriber.telegramId ?? "—"}`
      }
      actions={
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Закрыть
        </button>
      }
    >
      <div className="kv">
        <div>
          <span className="kv-key">ID подписки</span>
          <span className="kv-val mono">{subscriber.id}</span>
        </div>
        <div>
          <span className="kv-key">Ссылка</span>
          <span className="kv-val">
            <span className="mono small">{subscriber.subscriptionUrl}</span>{" "}
            <CopyButton value={subscriber.subscriptionUrl} />
          </span>
        </div>
        <div>
          <span className="kv-key">Статус</span>
          <span className="kv-val">
            <StatusBadge status={subscriber.status} />
          </span>
        </div>
        <div>
          <span className="kv-key">Истекает</span>
          <span className="kv-val">{formatDateTime(subscriber.expireAt)}</span>
        </div>
        <div>
          <span className="kv-key">Трафик</span>
          <span className="kv-val">{formatBytes(subscriber.usedTrafficBytes)}</span>
        </div>
      </div>

      <h3 className="form-section">Использование по нодам</h3>
      <div className="inline-form">
        <Field label="shortUuid подписки" hint="Подставлен из выбранной подписки; можно заменить на любой другой.">
          <input value={shortUuid} onChange={(e) => setShortUuid(e.target.value)} placeholder="demoshortuuid0001" />
        </Field>
        <button type="button" className="btn" onClick={load} disabled={loading}>
          {loading ? "Загружаем…" : "Загрузить"}
        </button>
      </div>

      {error && <ErrorBox error={error} />}
      {usage !== null &&
        (usage.length === 0 ? (
          <EmptyState text="Статистики по этой подписке нет" hint="Агенты ещё не прислали дельты трафика." />
        ) : (
          <Table columns={columns} rows={usage} rowKey={(r) => `${r.day}:${r.nodeId}`} />
        ))}

      <AccessBlock subscriber={subscriber} onChanged={onChanged} />
      <DevicesBlock subscriptionId={subscriber.id} deviceLimit={subscriber.deviceLimit} />
      <RevokeBlock subscriptionId={subscriber.id} />
    </Card>
  );
}

const CAN_DISABLE = ["active", "trial", "suspended", "expired"];
const CAN_ENABLE = ["disabled", "suspended"];

/**
 * Срок и доступ: продление на N дней и отключение/включение. Включение снимает и
 * приостановку за abuse (suspended). Продление блокировку не снимает — только «Включить».
 */
function AccessBlock({ subscriber, onChanged }: { subscriber: Subscriber; onChanged: () => void }) {
  const canEdit = useCan("admin");
  const [days, setDays] = useState("30");
  // ключ продления живёт до успеха: дабл-клик уйдёт с тем же ключом и дни не задвоит
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) return null;

  const forever = subscriber.expireAt === null && subscriber.status !== "inactive";

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const extend = () => {
    const term = Number(days);
    if (!Number.isInteger(term) || term < 1) return setError("срок — целое число дней");
    void run(async () => {
      await extendSubscription(subscriber.id, term, requestId);
      setRequestId(crypto.randomUUID());
    });
  };

  return (
    <>
      <h3 className="form-section">Срок и доступ</h3>
      {error && <ErrorBox error={error} />}
      <div className="inline-form">
        {forever ? (
          <span className="small">Бессрочная — продлевать некуда.</span>
        ) : (
          <>
            <Field label="Продлить на, дней" hint="от текущего окончания, если оно впереди">
              <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
            </Field>
            <button type="button" className="btn" onClick={extend} disabled={busy}>
              Продлить
            </button>
          </>
        )}
        {CAN_DISABLE.includes(subscriber.status) && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(() => setSubscriptionEnabled(subscriber.id, false))}
          >
            Отключить
          </button>
        )}
        {CAN_ENABLE.includes(subscriber.status) && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(() => setSubscriptionEnabled(subscriber.id, true))}
          >
            Включить
          </button>
        )}
      </div>
    </>
  );
}

/** Устройства подписки: занятые слоты и отвязка застрявшего устройства. */
function DevicesBlock({ subscriptionId, deviceLimit }: { subscriptionId: string; deviceLimit: number | null }) {
  // Саппорт видит устройства, но не отвязывает: core отвечает на это 403, и кнопка,
  // которая всегда падает, хуже её отсутствия.
  const canEdit = useCan("admin");
  const [devices, setDevices] = useState<SubscriberDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setDevices(await getDevices(subscriptionId));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
    // подписка сменилась — список надо перечитать, иначе покажем чужие устройства
  }, [subscriptionId]);

  const unlink = async (hwid: string) => {
    setBusy(hwid);
    setError(null);
    try {
      await unlinkDevice(subscriptionId, hwid);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<SubscriberDevice>[] = [
    { key: "hwid", title: "HWID", render: (d) => <span className="mono small">{d.hwid}</span> },
    { key: "os", title: "Платформа", render: (d) => d.deviceOs ?? "—" },
    { key: "model", title: "Модель", render: (d) => d.deviceModel ?? "—" },
    { key: "last", title: "Последний раз", render: (d) => formatDateTime(d.lastSeenAt) },
  ];

  if (canEdit) {
    columns.push({
      key: "act",
      title: "",
      align: "right",
      render: (d) => (
        <button type="button" className="btn btn-sm" onClick={() => void unlink(d.hwid)} disabled={busy === d.hwid}>
          {busy === d.hwid ? "…" : "Отвязать"}
        </button>
      ),
    });
  }

  return (
    <>
      <h3 className="form-section">
        Устройства {devices ? `(${devices.length}${deviceLimit ? ` из ${deviceLimit}` : ""})` : ""}
      </h3>
      {error && <ErrorBox error={error} />}
      {devices === null ? (
        <Loading />
      ) : devices.length === 0 ? (
        <EmptyState text="Устройств нет" hint="Клиент ещё не открывал подписку или не шлёт HWID." />
      ) : (
        <Table columns={columns} rows={devices} rowKey={(d) => d.hwid} />
      )}
    </>
  );
}

/**
 * Перевыпуск подписки при утечке ссылки. Действие необратимое и рвёт доступ
 * до тех пор, пока клиент не заберёт новую ссылку в боте, поэтому с подтверждением.
 */
function RevokeBlock({ subscriptionId }: { subscriptionId: string }) {
  const canRevoke = useCan("admin");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await revokeSubscription(subscriptionId);
      setResult(r.subscriptionUrl);
      setConfirming(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!canRevoke) return null;

  return (
    <>
      <h3 className="form-section">Перевыпуск подписки</h3>
      {error && <ErrorBox error={error} />}
      {result ? (
        <p className="small">
          Новая ссылка: <span className="mono">{result}</span>. Старая больше не работает — клиент заберёт новую в боте.
        </p>
      ) : confirming ? (
        <div className="inline-form">
          <span className="small">
            Старая ссылка перестанет работать сразу, устройства отвяжутся. Клиенту придётся взять новую в боте.
          </span>
          <button type="button" className="btn btn-danger" onClick={() => void revoke()} disabled={busy}>
            {busy ? "Перевыпускаем…" : "Да, перевыпустить"}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
            Отмена
          </button>
        </div>
      ) : (
        <div className="inline-form">
          <span className="small">Применять при утечке ссылки: меняет адрес подписки и идентификатор в конфиге.</span>
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            Перевыпустить
          </button>
        </div>
      )}
    </>
  );
}
