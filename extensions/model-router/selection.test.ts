import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  demotePeakProviders,
  leaveReason,
  metricsFromWindows,
  parseCandidateString,
  selectProvider,
  type SelectionInput,
} from "./selection.ts";

function base(overrides: Partial<SelectionInput>): SelectionInput {
  return {
    providerPriority: ["zai", "openai-codex", "claude"],
    peakProviders: new Set<string>(),
    quotas: {},
    brokenProviders: new Set<string>(),
    tier: {
      zai: "glm-5.3:high",
      "openai-codex": "gpt-5.6-sol:xhigh",
      claude: "claude-opus",
    },
    ...overrides,
  };
}

const LOW = { wk: 10, fh: 20 };

describe("parseCandidateString", () => {
  it("парсит model:thinking по последнему двоеточию", () => {
    assert.deepEqual(parseCandidateString("glm-5.3:high"), {
      model: "glm-5.3",
      thinking: "high",
    });
    assert.deepEqual(parseCandidateString("a:b:c"), {
      model: "a:b",
      thinking: "c",
    });
  });

  it("парсит модель без thinking", () => {
    assert.deepEqual(parseCandidateString("claude-opus"), {
      model: "claude-opus",
    });
  });

  it("отвергает мусор", () => {
    assert.equal(parseCandidateString(""), undefined);
    assert.equal(parseCandidateString(":high"), undefined);
    assert.equal(parseCandidateString("model:"), undefined);
  });
});

describe("demotePeakProviders", () => {
  it("демоция одного peak-провайдера в конец", () => {
    assert.deepEqual(
      demotePeakProviders(["zai", "openai", "claude"], new Set(["zai"])),
      ["openai", "claude", "zai"],
    );
  });

  it("стабильный порядок при нескольких пик-провайдерах", () => {
    assert.deepEqual(
      demotePeakProviders(
        ["zai", "openai", "claude"],
        new Set(["zai", "openai"]),
      ),
      ["claude", "zai", "openai"],
    );
  });

  it("без пика порядок неизменен", () => {
    assert.deepEqual(demotePeakProviders(["b", "a"], new Set()), ["b", "a"]);
  });
});

describe("metricsFromWindows", () => {
  it("берёт wk/5h и исключает mcp", () => {
    assert.deepEqual(
      metricsFromWindows([
        { label: "5h", usedPercent: 30 },
        { label: "wk", usedPercent: 70 },
        { label: "mcp", usedPercent: 99 },
      ]),
      { wk: 70, fh: 30 },
    );
  });

  it("нет окон — нет метрик", () => {
    assert.deepEqual(
      metricsFromWindows([{ label: "mcp", usedPercent: 50 }]),
      {},
    );
  });
});

describe("selectProvider", () => {
  it("проход 1: wk<60 и fh!=100", () => {
    const result = selectProvider(
      base({
        quotas: { zai: { wk: 59, fh: 100 }, "openai-codex": LOW, claude: LOW },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.decision.provider, "openai-codex");
    assert.equal(result.decision.pass, 1);
    assert.equal(result.decision.modelString, "openai-codex/gpt-5.6-sol:xhigh");
    assert.equal(result.decision.wk, 10);
    assert.equal(result.decision.fh, 20);
  });

  it("проход 2: 60<=wk<80", () => {
    const result = selectProvider(
      base({
        quotas: { zai: { wk: 70, fh: 50 }, "openai-codex": { wk: 5, fh: 100 } },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.decision.provider, "zai");
    assert.equal(result.decision.pass, 2);
  });

  it("проход 3: 80<=wk<100", () => {
    const result = selectProvider(
      base({
        quotas: {
          zai: { wk: 95, fh: 50 },
          "openai-codex": { wk: 85, fh: 100 },
        },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.decision.provider, "zai");
    assert.equal(result.decision.pass, 3);
  });

  it("fh=100 проваливает все проходы", () => {
    const result = selectProvider(
      base({
        quotas: { zai: { wk: 5, fh: 100 }, "openai-codex": LOW, claude: LOW },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.decision.provider, "openai-codex");
  });

  it("wk=100 проваливает все проходы, уходит к следующему", () => {
    const result = selectProvider(
      base({
        quotas: { zai: { wk: 100, fh: 50 }, "openai-codex": LOW, claude: LOW },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.decision.provider, "openai-codex");
  });

  it("нет данных по окну — проход не проходит", () => {
    const noFh = selectProvider(
      base({ quotas: { zai: { wk: 5, fh: 5 }, "openai-codex": { wk: 5 } } }),
    );
    assert.ok(noFh.ok);
    assert.equal(noFh.decision.provider, "zai");

    const noData = selectProvider(
      base({
        quotas: { zai: LOW, "openai-codex": undefined, claude: undefined },
      }),
    );
    assert.ok(noData.ok);
    assert.equal(noData.decision.provider, "zai");
  });

  it("peak-демоция меняет выбор", () => {
    const result = selectProvider(
      base({
        peakProviders: new Set(["zai"]),
        quotas: { zai: LOW, "openai-codex": LOW, claude: LOW },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.decision.provider, "openai-codex");
  });

  it("429-брейкер = wk=100-эквивалент", () => {
    const result = selectProvider(
      base({
        brokenProviders: new Set(["zai"]),
        quotas: { zai: LOW, "openai-codex": LOW, claude: LOW },
      }),
    );
    assert.ok(result.ok);
    assert.equal(result.decision.provider, "openai-codex");
  });

  it("все исчерпаны: причины wk=100 / 5h=100 / no data", () => {
    const result = selectProvider(
      base({
        quotas: {
          zai: { wk: 100, fh: 100 },
          "openai-codex": { wk: 50, fh: 100 },
        },
        tier: { zai: "glm:high", "openai-codex": "gpt:xhigh" },
        providerPriority: ["zai", "openai-codex"],
      }),
    );
    assert.ok(!result.ok);
    assert.deepEqual(result.exhausted, [
      { provider: "zai", reason: "wk=100" },
      { provider: "openai-codex", reason: "5h=100" },
    ]);
  });

  it("все исчерпаны: брейкер = 429 без данных и с исчерпанными окнами", () => {
    const noData = selectProvider(
      base({
        providerPriority: ["zai"],
        tier: { zai: "glm:high" },
        brokenProviders: new Set(["zai"]),
      }),
    );
    assert.ok(!noData.ok);
    assert.deepEqual(noData.exhausted, [{ provider: "zai", reason: "429" }]);

    const fullWindows = selectProvider(
      base({
        providerPriority: ["zai"],
        tier: { zai: "glm:high" },
        brokenProviders: new Set(["zai"]),
        quotas: { zai: { wk: 100, fh: 100 } },
      }),
    );
    assert.ok(!fullWindows.ok);
    assert.deepEqual(fullWindows.exhausted, [
      { provider: "zai", reason: "429" },
    ]);
  });
});

describe("leaveReason", () => {
  it("брейкер -> hit 429", () => {
    assert.equal(leaveReason(true, { wk: 100, fh: 100 }), "hit 429");
  });

  it("wk=100 -> hit wk limit", () => {
    assert.equal(leaveReason(false, { wk: 100, fh: 50 }), "hit wk limit");
  });

  it("5h=100 -> hit 5h limit", () => {
    assert.equal(leaveReason(false, { wk: 50, fh: 100 }), "hit 5h limit");
  });

  it("нет данных -> no quota data", () => {
    assert.equal(leaveReason(false, undefined), "no quota data");
    assert.equal(leaveReason(false, { wk: 50 }), "no quota data");
    assert.equal(leaveReason(false, { fh: 50 }), "no quota data");
  });

  it("здоров, но не первый в порядке -> priority", () => {
    assert.equal(leaveReason(false, { wk: 70, fh: 50 }), "priority");
    assert.equal(leaveReason(false, { wk: 31, fh: 40 }), "priority");
  });
});
