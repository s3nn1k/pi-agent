import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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

const window = (resetAtMs?: number, label = "5h"): PingWindow => ({
  label,
  usedPercent: 0,
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
    assert.equal(needsPing([window(NOW + 1000)], NOW), false);
  });

  it("окно с прошлым reset → спит", () => {
    assert.equal(needsPing([window(NOW - 1000)], NOW), true);
  });

  it("окно без resetAtMs → спит", () => {
    assert.equal(needsPing([window()], NOW), true);
  });

  it("пустой список окон → спит", () => {
    assert.equal(needsPing([], NOW), true);
  });

  it("смешанный список: одно будущее окно блокирует пинг", () => {
    assert.equal(
      needsPing([window(NOW - 1000, "5h"), window(NOW + 60_000, "wk")], NOW),
      false,
    );
  });

  it("resetAtMs ровно на now → не в будущем → спит", () => {
    assert.equal(needsPing([window(NOW)], NOW), true);
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
  it("ключ = первый resetAtMs окна", () => {
    assert.equal(windowKey([window(111), window(222)], NOW), 111);
  });

  it("без resetAtMs → fallback floor(now / час)", () => {
    assert.equal(windowKey([], NOW), Math.floor(NOW / HOUR));
    assert.equal(windowKey([window()], NOW), Math.floor(NOW / HOUR));
  });

  it("isWindowPinged: сохранённый ключ совпал с текущим → true", () => {
    const saved = { windowKey: windowKey([], NOW), pingedAtMs: NOW };
    assert.equal(isWindowPinged(saved, [], NOW), true);
  });

  it("isWindowPinged: сохранённый ключ = resetAtMs из снапшота → true", () => {
    const saved = { windowKey: 555, pingedAtMs: NOW };
    assert.equal(isWindowPinged(saved, [window(555)], NOW), true);
  });

  it("isWindowPinged: окно сменилось → false", () => {
    const saved = { windowKey: 555, pingedAtMs: NOW };
    assert.equal(isWindowPinged(saved, [window(777)], NOW), false);
    assert.equal(isWindowPinged(undefined, [window(555)], NOW), false);
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
