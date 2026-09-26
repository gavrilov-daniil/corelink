/**
 * Боевой исполнитель пробы: сбой самой пробы должен быть отдельной ошибкой, а не
 * «канал не прошёл» — иначе отсутствующий бинарь на воркере нарисовал бы «упали все».
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Путь к xray читается при загрузке модуля — задаём до импорта.
process.env.XRAY_BIN = "/nonexistent/corelink-xray";
const { xrayCurlExecutor, ProbeInfraError } = await import("./probe-executor.js");

describe("xrayCurlExecutor", () => {
  it("нет бинаря xray — ProbeInfraError, а не провал каналов", async () => {
    await assert.rejects(
      () => xrayCurlExecutor({}, [{ tag: "loc-000000000001", port: 45_678 }]),
      (e) => e instanceof ProbeInfraError && /xray пробы не поднялся/.test((e as Error).message),
    );
  });

  it("нет каналов — нечего проверять и нечего запускать", async () => {
    assert.deepEqual(await xrayCurlExecutor({}, []), []);
  });
});
