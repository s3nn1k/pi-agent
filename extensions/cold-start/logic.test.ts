import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { QuotaWarmup } from "../lib/quota/types";
import {
  isWindowPinged,
  loadState,
  needsPing,
  parseState,
  pickModel,
  reportLine,
  saveState,
  windowKey,
  type PingModelCandidate,
  type PingWindow,
} from "./logic.ts";

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;

const warmup: QuotaWarmup = { windowLabel: "5h", ceilingLabels: ["wk"] };

const window = (
  resetAtMs?: number,
  label = "5h",
  usedPercent = 0,
): PingWindow => ({
  label,
  usedPercent,
  ...(resetAtMs === undefined ? {} : { resetAtMs }),
});

const model = (
  id: string,
  input: number,
  output: number,
  off?: string | null,
): PingModelCandidate & { id: string } => ({
  id,
  cost: { input, output },
  ...(off === undefined ? {} : { thinkingLevelMap: { off } }),
});

describe("needsPing", () => {
  it("окно с будущим reset → не спит", () => {
    assert.equal(needsPing([window(NOW + 1000)], warmup, NOW), false);
  });

  it("окно с прошлым reset → спит", () => {
    assert.equal(needsPing([window(NOW - 1000)], warmup, NOW), true);
  });

  it("окно без resetAtMs → спит", () => {
    assert.equal(needsPing([window()], warmup, NOW), true);
  });

  it("пустой список окон → спит", () => {
    assert.equal(needsPing([], warmup, NOW), true);
  });

  it("спящий 5h без reset + живой wk → спит (wk не блокирует)", () => {
    assert.equal(
      needsPing(
        [window(undefined, "5h"), window(NOW + 60_000, "wk")],
        warmup,
        NOW,
      ),
      true,
    );
  });

  it("открытый 5h (reset в будущем) → не спит", () => {
    assert.equal(
      needsPing(
        [window(NOW + 60_000, "5h"), window(NOW + 1000, "wk")],
        warmup,
        NOW,
      ),
      false,
    );
  });

  it("спящий 5h + wk исчерпан → не спит (нет запаса)", () => {
    assert.equal(
      needsPing(
        [window(undefined, "5h"), window(NOW + 60_000, "wk", 100)],
        warmup,
        NOW,
      ),
      false,
    );
  });

  it("спящий 5h сам исчерпан (без reset) → не спит", () => {
    assert.equal(
      needsPing(
        [window(undefined, "5h", 100), window(NOW + 60_000, "wk")],
        warmup,
        NOW,
      ),
      false,
    );
  });

  it("mcp исчерпан + спящий 5h + живой wk → спит (mcp не гейтит)", () => {
    assert.equal(
      needsPing(
        [
          window(NOW + 1000, "mcp", 100),
          window(undefined, "5h"),
          window(NOW + 60_000, "wk"),
        ],
        warmup,
        NOW,
      ),
      true,
    );
  });

  it("resetAtMs ровно на now → не в будущем → спит", () => {
    assert.equal(needsPing([window(NOW)], warmup, NOW), true);
  });
});

describe("pickModel", () => {
  it("нулевые цены игнорируются при наличии моделей с ненулевой суммой", () => {
    const picked = pickModel([
      model("free", 0, 0),
      model("cheap", 0.1, 0.2),
      model("expensive", 1, 2),
    ]);
    assert.equal(picked?.id, "cheap");
  });

  it("tie-break по сумме: min по input+output", () => {
    const picked = pickModel([
      model("a", 0.5, 0.5),
      model("b", 0.2, 0.2),
      model("c", 0.3, 0.3),
    ]);
    assert.equal(picked?.id, "b");
  });

  it("при равной сумме предпочитается модель с thinkingLevelMap.off", () => {
    const picked = pickModel([
      model("plain", 0.1, 0.2),
      model("with-off", 0.2, 0.1, "low"),
    ]);
    assert.equal(picked?.id, "with-off");
  });

  it("thinkingLevelMap.off = null не считается поддержкой off", () => {
    const picked = pickModel([
      model("plain", 0.1, 0.2),
      model("off-null", 0.2, 0.1, null),
    ]);
    assert.equal(picked?.id, "plain");
  });

  it("все нулевые → абсолютный min, tie-break off работает", () => {
    assert.equal(
      pickModel([model("x", 0, 0), model("y", 0, 0, "off")])?.id,
      "y",
    );
    assert.equal(pickModel([model("x", 0, 0), model("y", 0, 0)])?.id, "x");
  });

  it("пустой список → undefined", () => {
    assert.equal(pickModel([]), undefined);
  });
});

describe("reportLine", () => {
  it("формат cold-start: <id>: <status>", () => {
    assert.equal(reportLine("openai", "warmed"), "cold-start: openai: warmed");
    assert.equal(
      reportLine("anthropic", "quota exceeded"),
      "cold-start: anthropic: quota exceeded",
    );
  });
});

describe("windowKey / isWindowPinged", () => {
  it("ключ = reset именно 5h-окна, не wk", () => {
    assert.equal(
      windowKey([window(222, "wk"), window(111, "5h")], warmup, NOW),
      111,
    );
  });

  it("без 5h-окна → fallback floor(now / час)", () => {
    assert.equal(windowKey([], warmup, NOW), Math.floor(NOW / HOUR));
    assert.equal(
      windowKey([window(NOW + 1000, "wk")], warmup, NOW),
      Math.floor(NOW / HOUR),
    );
  });

  it("5h без resetAtMs → fallback floor(now / час)", () => {
    assert.equal(
      windowKey([window(undefined, "5h")], warmup, NOW),
      Math.floor(NOW / HOUR),
    );
  });

  it("isWindowPinged: сохранённый ключ совпал → true", () => {
    const windows = [window(555, "5h"), window(777, "wk")];
    const saved = {
      windowKey: windowKey(windows, warmup, NOW),
      pingedAtMs: NOW,
    };
    assert.equal(isWindowPinged(saved, windows, warmup, NOW), true);
  });

  it("isWindowPinged: ключ wk-окна не засчитывается → false", () => {
    const saved = { windowKey: 777, pingedAtMs: NOW };
    assert.equal(
      isWindowPinged(
        saved,
        [window(555, "5h"), window(777, "wk")],
        warmup,
        NOW,
      ),
      false,
    );
  });

  it("isWindowPinged: окно сменилось → false", () => {
    const saved = { windowKey: 555, pingedAtMs: NOW };
    assert.equal(
      isWindowPinged(
        saved,
        [window(777, "5h"), window(999, "wk")],
        warmup,
        NOW,
      ),
      false,
    );
    assert.equal(
      isWindowPinged(undefined, [window(555, "5h")], warmup, NOW),
      false,
    );
  });
});

describe("стейт round-trip", () => {
  it("saveState → loadState возвращает те же данные, tmp-файл убран", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cold-start-test-"));
    const path = join(dir, "cold-start.json");
    try {
      const state = {
        openai: { windowKey: 1728000000, pingedAtMs: NOW },
        anthropic: { windowKey: "wk-reset", pingedAtMs: NOW + 1 },
      };
      await saveState(path, state);
      assert.deepEqual(await loadState(path), state);
      await assert.rejects(stat(`${path}.tmp`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("отсутствующий файл → пустой стейт", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cold-start-test-"));
    try {
      assert.deepEqual(await loadState(join(dir, "missing.json")), {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("битый JSON и некорректные записи отбрасываются", async () => {
    assert.deepEqual(parseState("not json"), {});
    assert.deepEqual(parseState("[1,2]"), {});
    assert.deepEqual(parseState('{"p": "str"}'), {});
    assert.deepEqual(parseState('{"p": {"pingedAtMs": 5}}'), {});
    assert.deepEqual(
      parseState(
        '{"ok": {"windowKey": 1, "pingedAtMs": 2}, "bad": {"windowKey": true, "pingedAtMs": 3}}',
      ),
      { ok: { windowKey: 1, pingedAtMs: 2 } },
    );
  });

  it("запись атомарна: контент читается целиком после rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cold-start-test-"));
    const path = join(dir, "cold-start.json");
    try {
      await writeFile(path, "stale", "utf8");
      await saveState(path, { p: { windowKey: 7, pingedAtMs: 8 } });
      const raw = await readFile(path, "utf8");
      assert.deepEqual(JSON.parse(raw), { p: { windowKey: 7, pingedAtMs: 8 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
