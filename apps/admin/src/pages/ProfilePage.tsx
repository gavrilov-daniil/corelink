import { useState } from "react";
import {
  changeOwnPassword,
  errorMessage,
  getTelegramLoginConfig,
  startTelegramLink,
  unlinkOwnTelegram,
  MIN_PASSWORD_LENGTH,
  ROLE_HINTS,
  ROLE_LABELS,
} from "../api";
import { useResource } from "../useResource";
import { useSession } from "../session";
import Card from "../components/Card";
import Field from "../components/Field";
import ErrorBox from "../components/ErrorBox";
import TelegramLoginButton from "../components/TelegramLoginButton";

/** Своя учётка: способы входа и пароль. Доступна всем ролям — это не управление доступом. */
export default function ProfilePage() {
  const { me, reload } = useSession();

  return (
    <>
      <div className="page-head">
        <h1>Мой профиль</h1>
      </div>

      <Card title={me.displayName ?? me.email ?? "Оператор"} subtitle={ROLE_HINTS[me.role]}>
        <div className="kv">
          <div>
            <span className="kv-key">Роль</span>
            <span className="kv-val">{ROLE_LABELS[me.role]}</span>
          </div>
          <div>
            <span className="kv-key">Email</span>
            <span className="kv-val">{me.email ?? "—"}</span>
          </div>
          <div>
            <span className="kv-key">Telegram</span>
            <span className="kv-val">{me.telegramUsername ? `@${me.telegramUsername}` : me.hasTelegram ? "привязан" : "—"}</span>
          </div>
        </div>
        {me.viaSharedToken && (
          <p className="notice">
            Вход по общему ADMIN_TOKEN. Учётки за ним нет: заведите себе именную на экране «Доступ» и войдите ею —
            общий токен после этого стоит убрать из env.
          </p>
        )}
      </Card>

      {!me.viaSharedToken && (
        <>
          <TelegramLinkCard hasTelegram={me.hasTelegram} hasPassword={me.hasPassword} onChanged={reload} />
          {me.email && <PasswordCard />}
        </>
      )}
    </>
  );
}

function TelegramLinkCard({
  hasTelegram,
  hasPassword,
  onChanged,
}: {
  hasTelegram: boolean;
  hasPassword: boolean;
  onChanged: () => void;
}) {
  const config = useResource(getTelegramLoginConfig).data ?? { enabled: false };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Card title="Вход через Telegram" subtitle="Привязанный аккаунт входит в эту же учётку, с той же ролью.">
      {error && <ErrorBox error={error} />}
      {!config.enabled ? (
        <p className="small muted">Вход по Telegram выключен в настройках. Включает его администратор.</p>
      ) : hasTelegram ? (
        <div className="inline-form">
          <span className="small">
            {hasPassword
              ? "Аккаунт привязан. Отвязка оставит только вход по email и паролю."
              : "Это единственный способ входа: пока нет пароля, отвязать нельзя."}
          </span>
          <button
            type="button"
            className="btn"
            disabled={busy || !hasPassword}
            onClick={() => {
              setBusy(true);
              setError(null);
              unlinkOwnTelegram()
                .then(onChanged)
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            Отвязать
          </button>
        </div>
      ) : (
        // Привязка идёт тем же уходом в Telegram, что и вход: вернувшись, страница
        // перечитает профиль, поэтому onChanged здесь не нужен.
        <TelegramLoginButton label="Привязать Telegram" start={startTelegramLink} onError={setError} />
      )}
    </Card>
  );
}

function PasswordCard() {
  const { signOut } = useSession();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card
      title="Смена пароля"
      subtitle="Смена рубит все сессии учётки, включая текущую: после неё нужно войти заново."
    >
      {error && <ErrorBox error={error} />}
      <div className="inline-form">
        <Field label="Новый пароль" hint={`Минимум ${MIN_PASSWORD_LENGTH} символов.`}>
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || password.length < MIN_PASSWORD_LENGTH}
          onClick={() => {
            setBusy(true);
            setError(null);
            changeOwnPassword(password)
              .then(() => signOut())
              .catch((e) => {
                setError(errorMessage(e));
                setBusy(false);
              });
          }}
        >
          {busy ? "Сохраняем…" : "Сменить пароль"}
        </button>
      </div>
    </Card>
  );
}
