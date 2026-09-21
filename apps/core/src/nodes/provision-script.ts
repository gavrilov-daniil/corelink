/**
 * Генератор bash-скрипта авто-настройки ноды. Скрипт выполняется НА сервере по SSH
 * (см. ssh-exec.ts) под root и с нуля приводит чистый Debian/Ubuntu в рабочую ноду:
 * ставит Xray, node-agent, кладёт конфиг агента с bootstrap-токеном и запускает его.
 * Дальше агент dial-out'ом забирает desired-state и поднимает Xray сам.
 *
 * Скрипт идемпотентен: повторный прогон переустанавливает поверх (Xray не трогаем,
 * если unit уже есть; бинарь, конфиг, unit агента перезаписываем). Это и есть
 * «перепрофилирование» на уровне сервера — тот же прогон с новым bootstrap-токеном.
 *
 * Три способа сломать, которые скрипт закрывает явно (set -euo pipefail + проверки):
 *   1. Не тот дистрибутив/арх — падаем на detect с внятным сообщением, а не на apt.
 *   2. Подменённый бинарь агента — проверяем SHA256 против SHA256SUMS из того же
 *      релиза; несовпадение = стоп до установки.
 *   3. Xray читает не тот конфиг — официальный installer кладёт его в
 *      /usr/local/etc/xray, а агент пишет в /etc/xray (его дефолт и ReadWritePaths
 *      в unit). Сводим оба на /etc/xray drop-in'ом к xray.service.
 *
 * Секреты: bootstrap-токен попадает только в config.json на сервере (heredoc его не
 * печатает в stdout). В лог прогона уходит именно stdout, не текст скрипта.
 */

// Готовый systemd-unit агента лежит в apps/node-agent/systemd/node-agent.service.
// Держим его копию здесь как единый артефакт установки: скрипт раздаёт unit на ноду,
// а тянуть его сетью в момент установки — лишняя точка отказа. При правке unit'а
// в node-agent синхронизировать сюда (оба места — про один и тот же демон).
const NODE_AGENT_UNIT = `[Unit]
Description=VPN node-agent (control-plane pull daemon)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/node-agent --config /etc/node-agent/config.json
Restart=always
RestartSec=5

User=node-agent
Group=node-agent
StateDirectory=node-agent
StateDirectoryMode=0750

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
ReadWritePaths=/etc/xray

[Install]
WantedBy=multi-user.target
`;

// Минимальный валидный конфиг Xray: официальный installer делает enable --now, а без
// конфига по нашему пути xray.service упал бы до первого прогона агента. Агент его
// перезапишет desired-state'ом и сделает restart.
const XRAY_BOOTSTRAP_CONFIG = JSON.stringify(
  { log: { loglevel: "warning" }, inbounds: [], outbounds: [{ protocol: "freedom" }] },
  null,
  2,
);

export interface ProvisionScriptParams {
  /** owner/repo для GitHub Release с бинарём агента. */
  repo: string;
  /** Тег релиза агента ("v0.1.0") или "latest". */
  agentRelease: string;
  /** База, куда агент дозванивается — SUB_PUBLIC_HOST (не админка). */
  controlPlaneUrl: string;
  nodeId: string;
  /** Одноразовый токен энроллмента. Уходит только в config.json на сервере. */
  bootstrapToken: string;
  /** Прибить версию Xray (напр. "1.8.24"); пусто — последняя от installer'а. */
  xrayVersion?: string;
}

/** Ссылки на бинарь агента и контрольные суммы из GitHub Release. */
function agentUrls(repo: string, release: string): { bin: string; sums: string } {
  const base =
    release === "latest"
      ? `https://github.com/${repo}/releases/latest/download`
      : `https://github.com/${repo}/releases/download/${release}`;
  // Arch-суффикс подставляет сам скрипт (uname), поэтому в имени файла оставляем маркер.
  return { bin: `${base}/node-agent-linux-`, sums: `${base}/SHA256SUMS` };
}

export function buildProvisionScript(p: ProvisionScriptParams): string {
  const { bin, sums } = agentUrls(p.repo, p.agentRelease);

  const config = {
    control_plane_url: p.controlPlaneUrl,
    node_id: p.nodeId,
    bootstrap_token: p.bootstrapToken,
    xray_config_path: "/etc/xray/config.json",
  };
  const configJson = JSON.stringify(config, null, 2);

  const xrayInstall = p.xrayVersion
    ? `bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install --version ${p.xrayVersion}`
    : `bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install`;

  // 'EOF' в кавычках — bash не интерполирует тело: значения уже подставлены здесь,
  // а $ARCH/$TMP внутри должны раскрываться на сервере, поэтому эти куски — вне кавычек.
  return `#!/usr/bin/env bash
set -euo pipefail

echo "=== 1/7 определение системы ==="
if [ ! -r /etc/os-release ]; then echo "нет /etc/os-release — неизвестная система"; exit 1; fi
. /etc/os-release
case "\${ID:-}" in
  ubuntu|debian) : ;;
  *) echo "неподдерживаемый дистрибутив: \${ID:-?} (нужен Ubuntu/Debian)"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) AGENT_ARCH=amd64 ;;
  aarch64|arm64) AGENT_ARCH=arm64 ;;
  *) echo "неподдерживаемая архитектура: $(uname -m)"; exit 1 ;;
esac
echo "OS \${ID} \${VERSION_ID:-?}, arch $(uname -m) -> \${AGENT_ARCH}"

echo "=== 2/7 базовые пакеты ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates >/dev/null

echo "=== 3/7 Xray ==="
if systemctl list-unit-files 2>/dev/null | grep -q '^xray\\.service'; then
  echo "xray.service уже установлен — пропускаем установку"
else
  ${xrayInstall}
fi
install -d -m 0755 /etc/xray
if [ ! -s /etc/xray/config.json ]; then
  cat > /etc/xray/config.json <<'XRAYCFG'
${XRAY_BOOTSTRAP_CONFIG}
XRAYCFG
fi
# Официальный unit читает /usr/local/etc/xray; агент пишет /etc/xray. Сводим на /etc/xray.
install -d -m 0755 /etc/systemd/system/xray.service.d
cat > /etc/systemd/system/xray.service.d/10-corelink-config.conf <<'XRAYDROP'
[Service]
ExecStart=
ExecStart=/usr/local/bin/xray run -config /etc/xray/config.json
XRAYDROP

echo "=== 4/7 пользователь node-agent ==="
id -u node-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin node-agent

echo "=== 5/7 бинарь node-agent (${p.agentRelease}) ==="
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/node-agent" "${bin}\${AGENT_ARCH}"
curl -fsSL -o "$TMP/SHA256SUMS" "${sums}"
EXPECT="$(grep "node-agent-linux-\${AGENT_ARCH}" "$TMP/SHA256SUMS" | awk '{print $1}')"
ACTUAL="$(sha256sum "$TMP/node-agent" | awk '{print $1}')"
if [ -z "$EXPECT" ] || [ "$EXPECT" != "$ACTUAL" ]; then
  echo "SHA256 не совпал (ожидали \${EXPECT:-?}, получили $ACTUAL) — установка прервана"; exit 1
fi
install -m 0755 "$TMP/node-agent" /usr/local/bin/node-agent

echo "=== 6/7 polkit + конфиг + unit агента ==="
install -d -m 0750 /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/50-node-agent-xray.rules <<'POLKIT'
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "xray.service" &&
      subject.user == "node-agent") {
    return polkit.Result.YES;
  }
});
POLKIT
install -d -m 0755 /etc/node-agent
cat > /etc/node-agent/config.json <<'AGENTCFG'
${configJson}
AGENTCFG
chmod 600 /etc/node-agent/config.json
cat > /etc/systemd/system/node-agent.service <<'AGENTUNIT'
${NODE_AGENT_UNIT}AGENTUNIT

echo "=== 7/7 запуск ==="
systemctl daemon-reload
# Xray: installer поднял его со своим путём (/usr/local/etc); рестарт применяет наш
# drop-in на /etc/xray/config.json. || true — конфиг пока минимальный, это норма.
systemctl enable xray.service >/dev/null 2>&1 || true
systemctl restart xray.service || true
systemctl enable node-agent.service >/dev/null 2>&1 || true
systemctl restart node-agent.service || true
# Ждём выхода агента в active. Type=simple + Restart: "activating"/крэш-цикл — это НЕ
# успех, поэтому ждём до 20 с и при неудаче собираем журнал в лог прогона (иначе
# причина падения не видна в админке).
active=""
for _ in $(seq 1 20); do
  active=$(systemctl is-active node-agent.service 2>/dev/null || true)
  [ "$active" = "active" ] && break
  sleep 1
done
echo "node-agent: $active"
if [ "$active" != "active" ]; then
  echo "--- systemctl status node-agent ---"
  systemctl status node-agent.service --no-pager -l 2>&1 | tail -n 25 || true
  echo "--- journalctl node-agent ---"
  journalctl -u node-agent.service --no-pager -n 80 2>&1 || true
  echo "ОШИБКА: node-agent не вышел в active за 20 с (см. журнал выше)"
  exit 1
fi
echo "=== готово: node-agent активен, ждёт desired-state ==="
`;
}
