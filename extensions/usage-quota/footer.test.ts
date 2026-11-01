import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { createUsageFooter } from "./footer.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const cwd = "/tmp/pi-footer-test";

function ctxMock(): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => [],
      getCwd: () => cwd,
      getSessionName: () => undefined,
    },
    getContextUsage: () => undefined,
    model: undefined,
  } as unknown as ExtensionContext;
}

function footerDataMock(
  statuses: Record<string, string> = {},
): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => undefined,
    getExtensionStatuses: () => new Map(Object.entries(statuses)),
    onBranchChange: () => () => undefined,
    getAvailableProviderCount: () => 1,
  } as unknown as ReadonlyFooterDataProvider;
}

function render(
  quotaLines: () => string[],
  width: number,
  statuses: Record<string, string> = { "scope-agents-md": "agent-only" },
): string[] {
  const footer = createUsageFooter(
    { requestRender: () => undefined },
    theme,
    footerDataMock(statuses),
    ctxMock(),
    true,
    () => "high",
    quotaLines,
    () => undefined,
  );
  return footer.render(width);
}

describe("createUsageFooter render", () => {
  it("первая строка: cwd | статусы | host", () => {
    assert.equal(render(() => [], 120)[0], `${cwd} | agent-only | host`);
  });

  it("пустые статусы отбрасываются: cwd | host", () => {
    assert.equal(render(() => [], 120, {})[0], `${cwd} | host`);
  });

  it("две строки квот склеиваются в одну, когда влезают в width", () => {
    const quota = () => [
      "[z] 5h:6(02.11) wk:1(08.11)",
      "[o] 5h:0(02.11) wk:98(04.11)",
    ];
    const lines = render(quota, 120);
    assert.equal(lines.length, 3);
    assert.equal(
      lines[2],
      "[z] 5h:6(02.11) wk:1(08.11) [o] 5h:0(02.11) wk:98(04.11)",
    );
  });

  it("квоты остаются двумя строками, когда склейка не влезает", () => {
    const quota = () => [
      "[z] 5h:6(02.11) wk:1(08.11)",
      "[o] 5h:0(02.11) wk:98(04.11)",
    ];
    const lines = render(quota, 40);
    assert.equal(lines.length, 4);
    assert.deepEqual(lines.slice(2), [
      "[z] 5h:6(02.11) wk:1(08.11)",
      "[o] 5h:0(02.11) wk:98(04.11)",
    ]);
  });

  it("statsLine между первой строкой и квотами не меняется", () => {
    const lines = render(() => [], 80);
    assert.equal(lines[1], `?/0 (auto)${" ".repeat(80 - 10 - 8)}no-model`);
  });
});
