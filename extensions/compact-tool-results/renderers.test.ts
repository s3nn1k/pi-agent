import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { createCompactToolRendererResolver } from "./renderers.ts";

initTheme("dark", false);

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function render(component: Component): string {
  return component
    .render(240)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trimEnd();
}

interface TestContext {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
  durationMs: number | undefined;
  outputPad: number;
}

function context(overrides: Partial<TestContext> = {}): TestContext {
  return {
    args: {},
    toolCallId: "tool-1",
    invalidate: () => undefined,
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    durationMs: 1250,
    outputPad: 1,
    ...overrides,
  };
}

function result(
  content: AgentToolResult<any>["content"] = [
    {
      type: "text",
      text: "output",
    },
  ],
  details: unknown = undefined,
): AgentToolResult<any> {
  return { content, details };
}

function nativeRenderers(events: string[]): ToolRenderers {
  return {
    renderCall(args, _theme, renderContext) {
      events.push(`call:${renderContext.lastComponent ? "reuse" : "new"}`);
      const component =
        renderContext.lastComponent instanceof Container
          ? renderContext.lastComponent
          : new Container();
      component.clear();
      component.addChild(
        new Text(
          `native code ${String((args as { code?: unknown }).code)}`,
          0,
          0,
        ),
      );
      return component;
    },
    renderResult(_result, options, _theme, renderContext) {
      events.push(
        `result:${options.expanded}:${renderContext.lastComponent ? "reuse" : "new"}`,
      );
      const component =
        renderContext.lastComponent instanceof Container
          ? renderContext.lastComponent
          : new Container();
      component.clear();
      component.addChild(new Text("native result with diagnostics", 0, 0));
      return component;
    },
  };
}

describe("createCompactToolRendererResolver", () => {
  it("leaves unrelated tools and their native renderers unchanged", () => {
    const native = nativeRenderers([]);
    const resolver = createCompactToolRendererResolver();
    assert.equal(
      resolver("bash", () => native),
      native,
    );
  });

  it("collapses codemode calls to a title and delegates expanded calls", () => {
    const events: string[] = [];
    const native = nativeRenderers(events);
    const wrapped = createCompactToolRendererResolver()(
      "codemode",
      () => native,
    );
    assert.ok(wrapped?.renderCall);

    const collapsedContext = context({
      args: { code: "return await tools.read({ path: 'secret' })" },
    });
    const collapsed = wrapped.renderCall(
      collapsedContext.args,
      theme,
      collapsedContext,
    );
    assert.equal(render(collapsed), "codemode");

    const expandedContext = context({
      args: collapsedContext.args,
      expanded: true,
      state: collapsedContext.state,
    });
    const expanded = wrapped.renderCall(
      expandedContext.args,
      theme,
      expandedContext,
    );
    assert.match(render(expanded), /native code/);
    assert.match(render(expanded), /secret/);
    assert.deepEqual(events, ["call:new"]);
  });

  it("reports native renderer failures before using the fallback", () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const wrapped = createCompactToolRendererResolver()(
        "mcp__server__tool",
        () => ({
          renderCall() {
            throw new Error("native failure");
          },
        }),
      );
      assert.ok(wrapped?.renderCall);
      const rendered = wrapped.renderCall(
        { value: "preserved" },
        theme,
        context({ expanded: true }),
      );
      assert.match(render(rendered), /preserved/);
    } finally {
      console.error = originalError;
    }
    assert.match(errors.join("\n"), /native call renderer failed/);
    assert.match(errors.join("\n"), /native failure/);
  });

  it("keeps native component types separate while toggling call and result", () => {
    const events: string[] = [];
    const wrapped = createCompactToolRendererResolver()("codemode", () =>
      nativeRenderers(events),
    );
    assert.ok(wrapped?.renderCall && wrapped.renderResult);
    const state = {};
    const args = { code: "return 1" };

    const collapsedCallContext = context({ args, state, expanded: false });
    const collapsedCall = wrapped.renderCall(args, theme, collapsedCallContext);
    assert.ok(collapsedCall instanceof Text);

    const expandedCallContext = context({ args, state, expanded: true });
    const expandedCall = wrapped.renderCall(args, theme, expandedCallContext);
    assert.ok(expandedCall instanceof Container);

    const collapsedResultContext = context({ args, state, expanded: false });
    const collapsedResult = wrapped.renderResult(
      result([{ type: "text", text: "result" }], { calls: [] }),
      { expanded: false, isPartial: false },
      theme,
      collapsedResultContext,
    );
    assert.ok(collapsedResult instanceof Text);

    const expandedResultContext = context({ args, state, expanded: true });
    const expandedResult = wrapped.renderResult(
      result([{ type: "text", text: "result" }], { calls: [] }),
      { expanded: true, isPartial: false },
      theme,
      expandedResultContext,
    );
    assert.ok(expandedResult instanceof Container);
    assert.match(render(expandedResult), /native result with diagnostics/);
    assert.deepEqual(events, ["call:new", "result:true:new"]);
  });

  it("shows nested errors and cancellations without exposing collapsed bodies", () => {
    const wrapped = createCompactToolRendererResolver()(
      "codemode",
      () => undefined,
    );
    assert.ok(wrapped?.renderResult);
    const output = "secret output\nsecond line\n".repeat(100);
    const rendered = wrapped.renderResult(
      result(
        [
          {
            type: "text",
            text: `Script completed\nWall time 1 seconds\nOutput:\n${output}`,
          },
        ],
        {
          calls: [
            { name: "ok-tool", args: '{"secret":true}', status: "ok" },
            { name: "failed-tool", args: "{}", status: "error" },
            { name: "cancelled-tool", args: "{}", status: "cancelled" },
          ],
        },
      ),
      { expanded: false, isPartial: false },
      theme,
      context(),
    );
    const text = render(rendered);
    assert.match(text, /ok/);
    assert.match(text, /3 calls/);
    assert.match(text, /1 error/);
    assert.match(text, /1 cancelled/);
    assert.match(text, /Took 1.3s/);
    assert.match(text, /expand/);
    assert.doesNotMatch(text, /secret output|failed-tool|cancelled-tool/);
  });

  it("keeps empty codemode output compact", () => {
    const wrapped = createCompactToolRendererResolver()(
      "codemode",
      () => undefined,
    );
    assert.ok(wrapped?.renderResult);
    const rendered = wrapped.renderResult(
      result([{ type: "text", text: "" }], { calls: [] }),
      { expanded: false, isPartial: false },
      theme,
      context({ durationMs: undefined }),
    );
    const text = render(rendered);
    assert.match(text, /0 lines/);
    assert.match(text, /expand/);
    assert.doesNotMatch(text, /undefined|null/);
  });

  it("updates collapsed codemode status and counts during streaming", () => {
    const wrapped = createCompactToolRendererResolver()(
      "codemode",
      () => undefined,
    );
    assert.ok(wrapped?.renderCall && wrapped.renderResult);
    const state = {};
    const args = { code: "return await tools.read({ path: 'x' })" };
    wrapped.renderCall(args, theme, context({ args, state }));

    const partial = wrapped.renderResult(
      result([{ type: "text", text: "partial" }], {
        calls: [{ name: "read", args: "{}", status: "running" }],
      }),
      { expanded: false, isPartial: true },
      theme,
      context({ args, state, isPartial: true, durationMs: undefined }),
    );
    assert.match(render(partial), /running/);
    assert.match(render(partial), /1 running/);

    const complete = wrapped.renderResult(
      result([{ type: "text", text: "done" }], {
        calls: [{ name: "read", args: "{}", status: "ok" }],
      }),
      { expanded: false, isPartial: false },
      theme,
      context({ args, state, durationMs: 20 }),
    );
    assert.match(render(complete), /ok/);
    assert.doesNotMatch(render(complete), /running/);
  });

  it("renders MCP calls compactly and preserves expanded fallback content", () => {
    const wrapped = createCompactToolRendererResolver()(
      "mcp__late-server__search",
      () => undefined,
    );
    assert.ok(wrapped?.renderCall && wrapped.renderResult);
    const args = { query: "secret query", limit: 4 };
    const collapsedCall = wrapped.renderCall(args, theme, context({ args }));
    assert.equal(render(collapsedCall), "late-server/search");

    const expandedContext = context({ args, expanded: true });
    const expandedCall = wrapped.renderCall(args, theme, expandedContext);
    assert.match(render(expandedCall), /secret query/);

    const expandedResult = wrapped.renderResult(
      result([
        { type: "text", text: "preserved MCP output" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ]),
      { expanded: true, isPartial: false },
      theme,
      expandedContext,
    );
    assert.match(render(expandedResult), /preserved MCP output/);
    assert.match(render(expandedResult), /1 image/);
  });

  it("uses restored native MCP renderers when they become available", () => {
    const events: string[] = [];
    const resolver = createCompactToolRendererResolver();
    const fallback = resolver("mcp__server__tool", () => undefined);
    const native = nativeRenderers(events);
    const restored = resolver("mcp__server__tool", () => native);
    assert.ok(fallback?.renderCall && restored?.renderCall);

    const fallbackCall = fallback.renderCall({ value: "x" }, theme, context());
    assert.equal(render(fallbackCall), "server/tool");
    const restoredCall = restored.renderCall(
      { code: "x" },
      theme,
      context({ expanded: true }),
    );
    assert.match(render(restoredCall), /native code/);
    assert.deepEqual(events, ["call:new"]);
  });
});
