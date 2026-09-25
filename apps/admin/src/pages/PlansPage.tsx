import { useState } from "react";
import { createPlan, errorMessage, getPlans, getSquads, updatePlan, type Plan, type Squad } from "../api";
import { useResource } from "../useResource";
import { formatKopeks } from "../format";
import Card from "../components/Card";
import Table, { type Column } from "../components/Table";
import Modal from "../components/Modal";
import Field from "../components/Field";
import Toggle from "../components/Toggle";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ErrorBox from "../components/ErrorBox";
import Loading from "../components/Loading";

export default function PlansPage() {
  const plans = useResource(getPlans);
  // squad'ы нужны только для подписей и выбора: не загрузились — тарифы всё равно правятся
  const squads = useResource(getSquads);
  const squadList = squads.data ?? [];
  const squadName = (id: string) => squadList.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const toggleActive = async (plan: Plan, isActive: boolean) => {
    setBusyId(plan.id);
    setActionError(null);
    try {
      await updatePlan(plan.id, { isActive });
      plans.reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<Plan>[] = [
    {
      key: "title",
      title: "Тариф",
      render: (p) => (
        <div>
          <div className="strong">{p.title}</div>
          <div className="muted small mono">{p.code}</div>
        </div>
      ),
    },
    { key: "period", title: "Период", align: "right", render: (p) => `${p.periodDays} дн` },
    { key: "price", title: "Цена", align: "right", render: (p) => formatKopeks(p.priceKopeks) },
    { key: "traffic", title: "Трафик", align: "right", render: (p) => (p.trafficGb ? `${p.trafficGb} ГБ` : "без лимита") },
    {
      key: "devices",
      title: "Устройств",
      align: "right",
      render: (p) => (p.deviceLimit ? String(p.deviceLimit) : "без лимита"),
    },
    { key: "trial", title: "Триал", render: (p) => (p.isTrial ? <StatusBadge status="ok" label="да" /> : "—") },
    {
      key: "active",
      title: "Включён",
      render: (p) => (
        <Toggle checked={p.isActive} disabled={busyId === p.id} onChange={(next) => toggleActive(p, next)} />
      ),
    },
    {
      key: "squads",
      title: "Squad'ы",
      render: (p) =>
        p.squadIds.length === 0 ? <span className="muted">только общий</span> : p.squadIds.map(squadName).join(", "),
    },
    { key: "sort", title: "Порядок", align: "right", render: (p) => p.sortOrder },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (p) => (
        <button type="button" className="btn btn-sm" onClick={() => setEditing(p)}>
          Изменить
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Тарифы</h1>
        <button type="button" className="btn" onClick={plans.reload}>
          Обновить
        </button>
      </div>

      {actionError && <ErrorBox error={actionError} />}

      <Card
        title="Тарифы"
        subtitle="Включая выключенные: пользователю бот показывает только включённые."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Создать тариф
          </button>
        }
      >
        {plans.loading && <Loading />}
        {plans.error && <ErrorBox error={plans.error} onRetry={plans.reload} />}
        {plans.data &&
          (plans.data.length === 0 ? (
            <EmptyState text="Тарифов нет" hint="Создайте первый — бот подхватит его сразу." />
          ) : (
            <Table columns={columns} rows={plans.data} rowKey={(p) => p.id} />
          ))}
      </Card>

      {creating && (
        <PlanModal
          squads={squadList}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            plans.reload();
          }}
        />
      )}
      {editing && (
        <PlanModal
          plan={editing}
          squads={squadList}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            plans.reload();
          }}
        />
      )}
    </>
  );
}

/** Пустая строка — «без лимита» (null в БД), а не ноль. */
function parseLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function PlanModal({
  plan,
  squads,
  onClose,
  onSaved,
}: {
  plan?: Plan;
  squads: Squad[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // выбор — только среди своих squad'ов: общий у всех подписок и так
  const ownSquads = squads.filter((s) => !s.forAll);
  const [squadIds, setSquadIds] = useState<string[]>(plan?.squadIds ?? []);
  const toggleSquad = (id: string, on: boolean) =>
    setSquadIds((prev) => (on ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
  const [code, setCode] = useState(plan?.code ?? "");
  const [title, setTitle] = useState(plan?.title ?? "");
  const [periodDays, setPeriodDays] = useState(String(plan?.periodDays ?? 30));
  const [priceRub, setPriceRub] = useState(plan ? String(plan.priceKopeks / 100) : "");
  const [trafficGb, setTrafficGb] = useState(plan?.trafficGb ? String(plan.trafficGb) : "");
  const [deviceLimit, setDeviceLimit] = useState(plan?.deviceLimit ? String(plan.deviceLimit) : "");
  const [isTrial, setIsTrial] = useState(plan?.isTrial ?? false);
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const period = Number(periodDays);
    // Цена вводится в рублях, хранится в копейках: округляем здесь, иначе «299.90»
    // приедет дробными копейками.
    const priceKopeks = Math.round(Number(priceRub) * 100);

    if (!title.trim()) {
      setError("нужно название");
      return;
    }
    if (!plan && !code.trim()) {
      setError("нужен код тарифа");
      return;
    }
    if (!Number.isInteger(period) || period <= 0) {
      setError("период — целое число дней больше нуля");
      return;
    }
    if (!Number.isFinite(priceKopeks) || priceKopeks < 0) {
      setError("цена должна быть неотрицательным числом");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (plan) {
        await updatePlan(plan.id, {
          title: title.trim(),
          periodDays: period,
          priceKopeks,
          trafficGb: parseLimit(trafficGb),
          deviceLimit: parseLimit(deviceLimit),
          isTrial,
          isActive,
          sortOrder: Number(sortOrder) || 0,
          squadIds,
        });
      } else {
        await createPlan({
          code: code.trim(),
          title: title.trim(),
          periodDays: period,
          priceKopeks,
          trafficGb: parseLimit(trafficGb) ?? undefined,
          deviceLimit: parseLimit(deviceLimit) ?? undefined,
          isTrial,
          sortOrder: Number(sortOrder) || 0,
          squadIds,
        });
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={plan ? `Тариф «${plan.title}»` : "Новый тариф"}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err">{error}</span>}
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "Сохраняем…" : plan ? "Сохранить" : "Создать"}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field
          label="Код"
          required={!plan}
          hint={plan ? "менять нельзя: код — ключ тарифа" : "латиницей: month, year, trial"}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} disabled={Boolean(plan)} placeholder="month" />
        </Field>
        <Field label="Название" required>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Месяц" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Период, дней" required>
          <input value={periodDays} onChange={(e) => setPeriodDays(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Цена, ₽" required hint="в БД хранится в копейках">
          <input value={priceRub} onChange={(e) => setPriceRub(e.target.value)} inputMode="decimal" placeholder="299" />
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Трафик, ГБ" hint="пусто — без лимита">
          <input value={trafficGb} onChange={(e) => setTrafficGb(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Лимит устройств" hint="пусто — без лимита">
          <input value={deviceLimit} onChange={(e) => setDeviceLimit(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <Field label="Порядок сортировки" hint="меньше — выше в списке у бота">
        <input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} inputMode="numeric" />
      </Field>

      <Field label="Пробный тариф" hint="выдаётся один раз на подписчика">
        <Toggle checked={isTrial} onChange={setIsTrial} label={isTrial ? "да" : "нет"} />
      </Field>

      <Field
        label="Squad'ы тарифа"
        hint="локации общего squad'а есть у всех; свой squad добавляет свои. Применяется при оплате и продлении"
      >
        {ownSquads.length === 0 ? (
          <span className="muted small">Своих squad'ов нет — клиенты тарифа получат локации общего.</span>
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

      {plan ? (
        <Field label="Включён" hint="выключенный пропадает из бота, но остаётся у уже оплативших">
          <Toggle checked={isActive} onChange={setIsActive} label={isActive ? "да" : "нет"} />
        </Field>
      ) : (
        <p className="muted small">
          Новый тариф создаётся включённым: эндпоинт создания флаг не принимает, выключить можно сразу после.
        </p>
      )}
    </Modal>
  );
}
