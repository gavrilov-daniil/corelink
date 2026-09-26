import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildProvisionScript, firewallStep, portCheckStep } from "./provision-script.js";

/**
 * Выполняет шаг скрипта настоящим bash, подменяя системные утилиты заглушками:
 * заглушка пишет свой вызов в calls.log и отвечает заданным текстом. Так проверяется
 * поведение (разбор вывода ss, выбор фаервола), а не только наличие строк в скрипте.
 */
function runStep(step: string, stubs: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "provision-step-"));
  const log = join(dir, "calls.log");
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const res = spawnSync("bash", ["-c", `set -euo pipefail\n${step}`], {
    env: { PATH: `${dir}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  return {
    code: res.status,
    out: `${res.stdout}${res.stderr}`,
    calls: existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}

/** Заглушка ss: на указанном порту слушает процесс proc (как в `ss -ltnpH` под root). */
const ssListening = (port: number, proc: string) =>
  `case "$*" in *":${port}"*) echo 'LISTEN 0 4096 0.0.0.0:${port} 0.0.0.0:* users:(("${proc}",pid=1678,fd=8))';; esac`;

describe("шаг «порты входа»", () => {
  it("свободный порт пропускает дальше", () => {
    const r = runStep(portCheckStep([8443]), { ss: "true" });
    assert.equal(r.code, 0);
    assert.match(r.out, /порт 8443 свободен/);
  });

  it("порт под чужим процессом — стоп с понятной причиной (de1-exit: 443 держал Caddy)", () => {
    const r = runStep(portCheckStep([443]), { ss: ssListening(443, "docker-proxy") });
    assert.equal(r.code, 1, "установка на занятый порт молча уронила бы Xray на bind");
    assert.match(r.out, /порт 443 занят процессом docker-proxy — выберите другой порт в мастере/);
  });

  it("порт под нашим xray — это повторная настройка, не ошибка", () => {
    const r = runStep(portCheckStep([443]), { ss: ssListening(443, "xray") });
    assert.equal(r.code, 0);
    assert.match(r.out, /уже слушает наш xray/);
  });

  it("слушатель без имени процесса считаем занятым", () => {
    const r = runStep(portCheckStep([443]), { ss: `echo 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*'` });
    assert.equal(r.code, 1);
    assert.match(r.out, /занят процессом без имени/);
  });

  it("проверяет каждый порт входа, а не один 443", () => {
    const r = runStep(portCheckStep([443, 8443]), { ss: ssListening(8443, "nginx") });
    assert.equal(r.code, 1);
    assert.match(r.out, /порт 443 свободен/);
    assert.match(r.out, /порт 8443 занят процессом nginx/);
  });
});

describe("шаг «фаервол»", () => {
  it("активный ufw — открывает порт входа с пометкой", () => {
    const r = runStep(firewallStep([8443]), {
      ufw: `if [ "$1" = status ]; then echo "Status: active"; else echo "Rule added"; echo "Rule added (v6)"; fi`,
    });
    assert.equal(r.code, 0);
    assert.match(r.calls, /ufw allow 8443\/tcp comment corelink xray/);
    assert.match(r.out, /ufw: 8443\/tcp — Rule added Rule added \(v6\)/);
  });

  it("повтор на ufw не плодит правило: ufw сам пропускает существующее", () => {
    const r = runStep(firewallStep([8443]), {
      ufw: `if [ "$1" = status ]; then echo "Status: active"; else echo "Skipping adding existing rule"; fi`,
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /Skipping adding existing rule/);
  });

  it("ufw установлен, но выключен, а firewalld работает — открывает через firewall-cmd", () => {
    const r = runStep(firewallStep([8443]), {
      ufw: `echo "Status: inactive"`,
      "firewall-cmd": `if [ "$1" = --state ]; then echo running; else echo success; fi`,
    });
    assert.equal(r.code, 0);
    assert.match(r.calls, /firewall-cmd --permanent --add-port=8443\/tcp/);
    assert.match(r.calls, /firewall-cmd --reload/);
    assert.doesNotMatch(r.calls, /ufw allow/);
  });

  it("фаервол не активен — ничего не трогает", () => {
    const r = runStep(firewallStep([8443]), { ufw: `echo "Status: inactive"` });
    assert.equal(r.code, 0);
    assert.match(r.out, /не активен — порты не трогаем/);
    assert.doesNotMatch(r.calls, /allow|add-port/);
  });

  it("ufw не смог открыть порт — стоп, а не молча недоступная нода", () => {
    const r = runStep(firewallStep([8443]), {
      ufw: `if [ "$1" = status ]; then echo "Status: active"; else echo "ERROR: bad port" >&2; exit 1; fi`,
    });
    assert.equal(r.code, 1);
    assert.match(r.out, /ufw не открыл 8443\/tcp/);
  });
});

describe("buildProvisionScript", () => {
  const base = {
    inboundPorts: [8443],
    repo: "acme/corelink",
    agentRelease: "v1.2.3",
    controlPlaneUrl: "https://sub.example.com",
    nodeId: "11111111-1111-1111-1111-111111111111",
    bootstrapToken: "boot-secret-xyz",
  };

  it("кладёт node_id, control_plane_url и bootstrap-токен в config агента", () => {
    const s = buildProvisionScript(base);
    assert.match(s, /"node_id": "11111111-1111-1111-1111-111111111111"/);
    assert.match(s, /"control_plane_url": "https:\/\/sub\.example\.com"/);
    assert.match(s, /"bootstrap_token": "boot-secret-xyz"/);
    assert.match(s, /"xray_config_path": "\/etc\/xray\/config\.json"/);
  });

  it("тянет бинарь агента и контрольные суммы из релиза по тегу", () => {
    const s = buildProvisionScript(base);
    assert.match(s, /releases\/download\/v1\.2\.3\/node-agent-linux-/);
    assert.match(s, /releases\/download\/v1\.2\.3\/SHA256SUMS/);
    assert.match(s, /sha256sum/);
  });

  it("для latest берёт releases/latest/download", () => {
    const s = buildProvisionScript({ ...base, agentRelease: "latest" });
    assert.match(s, /releases\/latest\/download\/node-agent-linux-/);
  });

  it("ставит Xray и сводит его конфиг на /etc/xray drop-in'ом", () => {
    const s = buildProvisionScript(base);
    assert.match(s, /Xray-install/);
    // Префикс 90- обязателен: наш drop-in должен применяться ПОСЛЕ installer'ового 10-donot.
    assert.match(s, /xray\.service\.d\/90-corelink-config\.conf/);
    assert.match(s, /xray run -config \/etc\/xray\/config\.json/);
  });

  it("создаёт polkit-rule на рестарт xray от пользователя node-agent", () => {
    const s = buildProvisionScript(base);
    assert.match(s, /polkit-1\/rules\.d\/50-node-agent-xray\.rules/);
    assert.match(s, /subject\.user == "node-agent"/);
  });

  it("отдаёт конфиг агента и Xray пользователю node-agent (иначе агент не прочитает свой конфиг)", () => {
    const s = buildProvisionScript(base);
    assert.match(s, /chown node-agent:node-agent \/etc\/node-agent\/config\.json/);
    assert.match(s, /User=node-agent/);
  });

  it("прибивает версию Xray, когда она задана", () => {
    const s = buildProvisionScript({ ...base, xrayVersion: "1.8.24" });
    assert.match(s, /install --version 1\.8\.24/);
  });

  it("ограничивает дистрибутив Debian/Ubuntu и различает архитектуры", () => {
    const s = buildProvisionScript(base);
    assert.match(s, /ubuntu\|debian/);
    assert.match(s, /x86_64\) AGENT_ARCH=amd64/);
    assert.match(s, /aarch64\|arm64\) AGENT_ARCH=arm64/);
  });

  it("включает set -euo pipefail и запуск агента", () => {
    const s = buildProvisionScript(base);
    assert.match(s, /set -euo pipefail/);
    assert.match(s, /systemctl restart node-agent\.service/);
    assert.match(s, /journalctl -u node-agent\.service/);
  });

  it("проверяет порты входа из inbound'ов ДО установки Xray и открывает их в фаерволе перед запуском", () => {
    const s = buildProvisionScript({ ...base, inboundPorts: [8443, 8443, 2087] });
    const ports = s.indexOf("=== 3/9 порты входа: 8443 2087 ===");
    const xray = s.indexOf("=== 4/9 Xray ===");
    const firewall = s.indexOf("=== 8/9 фаервол ===");
    const start = s.indexOf("=== 9/9 запуск ===");
    assert.ok(ports > 0 && ports < xray, "занятый порт надо поймать до установки, а не после");
    assert.ok(firewall > xray && firewall < start);
    assert.match(s, /for port in 8443 2087; do/, "порты — из inbound'ов, без повторов и без хардкода 443");
    assert.doesNotMatch(s, /for port in 443/);
  });

  it("даёт агенту читать журнал Xray, чтобы причина падения доходила до админки", () => {
    assert.match(buildProvisionScript(base), /SupplementaryGroups=systemd-journal/);
  });

  it("скрипт целиком синтаксически корректен для bash (bash -n)", () => {
    for (const inboundPorts of [[8443], []]) {
      const res = spawnSync("bash", ["-n"], { input: buildProvisionScript({ ...base, inboundPorts }), encoding: "utf8" });
      assert.equal(res.status, 0, `bash -n: ${res.stderr}`);
    }
  });
});
