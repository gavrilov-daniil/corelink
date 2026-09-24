import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProvisionScript } from "./provision-script.js";

describe("buildProvisionScript", () => {
  const base = {
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
});
