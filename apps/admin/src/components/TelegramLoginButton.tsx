import { useState } from "react";
import { errorMessage } from "../api";

interface Props {
  label: string;
  /** Ручка, выдающая ссылку на экран Telegram: вход или привязка. */
  start: () => Promise<{ url: string }>;
  onError: (message: string) => void;
}

/**
 * Кнопка ухода в Telegram. Прежний Login Widget рисовал себя сам в iframe с
 * telegram.org; в Web Login браузер просто переходит по ссылке, которую выдал
 * наш сервер, — сторонний скрипт на странице входа больше не нужен.
 */
export default function TelegramLoginButton({ label, start, onError }: Props) {
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      const { url } = await start();
      // Не открываем новую вкладку: кука входа поставлена этому окну, и возврат
      // от Telegram должен прийти в него же.
      window.location.assign(url);
    } catch (err) {
      onError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <button type="button" className="btn" disabled={busy} onClick={() => void go()}>
      {busy ? "Открываем Telegram…" : label}
    </button>
  );
}
