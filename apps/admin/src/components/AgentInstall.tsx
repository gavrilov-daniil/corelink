import CopyButton from "./CopyButton";

/**
 * Команда установки node-agent на сервер: пишет /etc/node-agent/config.json с
 * подставленными node_id и bootstrap-токеном и запускает сервис. Ключи и дефолты —
 * из apps/node-agent/internal/config/config.go (обязательны control_plane_url,
 * node_id, xray_config_path; reality_private_key_path и state_dir по умолчанию).
 * control_plane_url = хост, отдающий /internal/agent/* (SUB_PUBLIC_HOST), — его
 * знает только деплой, поэтому оставляем плейсхолдером.
 */
export function agentInstallSnippet(nodeId: string, token: string): string {
  return [
    "# бинарь node-agent и systemd-юнит поставьте из GitHub Release (см. apps/node-agent/README.md),",
    "# затем пропишите конфиг этой ноды и запустите сервис:",
    "sudo install -d -m 0755 /etc/node-agent",
    "sudo tee /etc/node-agent/config.json >/dev/null <<'JSON'",
    "{",
    '  "control_plane_url": "https://<SUB_PUBLIC_HOST>",',
    `  "node_id": "${nodeId}",`,
    `  "bootstrap_token": "${token}",`,
    '  "xray_config_path": "/etc/xray/config.json"',
    "}",
    "JSON",
    "sudo systemctl enable --now node-agent",
  ].join("\n");
}

/**
 * Блок «Установка агента» на экране bootstrap-токена. Общий для «Инфраструктуры»
 * и «Нод и каскадов»: команда выпуска токена одна, чтобы не расходилась между
 * двумя местами.
 */
export default function AgentInstall({ nodeId, token }: { nodeId: string; token: string }) {
  const snippet = agentInstallSnippet(nodeId, token);
  return (
    <>
      <h3 className="form-section">Установка агента на сервер</h3>
      <pre className="code">{snippet}</pre>
      <div className="row-actions">
        <CopyButton value={snippet} title="Скопировать команду" />
      </div>
      <p className="muted small">
        NODE_ID и токен уже подставлены. Замените <span className="mono">&lt;SUB_PUBLIC_HOST&gt;</span> на хост,
        который отдаёт <span className="mono">/internal/agent/*</span>. Бинарь агента и systemd-юнит — из GitHub
        Release; подробности в <span className="mono">apps/node-agent/README.md</span>.
      </p>
    </>
  );
}
