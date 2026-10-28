import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AssistantMessageComponent,
  ExtensionSelectorComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { registerCommandFilter } from "./command-filter.ts";
import {
  createWorkflowMarkdownTransformer,
  foldWorkflowMarkdown,
} from "./workflow-folding.ts";
initTheme("dark", false);
const APP_KEYBINDINGS = {
  "app.tools.expand": {
    defaultKeys: "ctrl+o",
    description: "Toggle tool output",
  },
} as const;
setKeybindings(new KeybindingsManager(APP_KEYBINDINGS));
const OPEN = String.fromCharCode(96).repeat(3);
const block = (language: string, body: string) =>
  OPEN + language + " workflow" + (body ? "\n" + body : "") + "\n" + OPEN;
const assistant = (text: string): any => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
});
const component = (source: string, transform: any) =>
  new AssistantMessageComponent(
    assistant(source),
    false,
    undefined,
    undefined,
    1,
    [transform],
  );
const render = (value: AssistantMessageComponent) =>
  stripTerminalSequences(value.render(240).join("\n"));
const assertRaw = (...sources: string[]) =>
  sources.forEach((source) =>
    assert.equal(foldWorkflowMarkdown(source, false), source),
  );
describe("workflow source folding", () => {
  it("folds exact tags, counts bodies, and preserves other fences", () => {
    const source = [
      "before",
      block("js", "one\ntwo"),
      "middle",
      block("javascript", ""),
      "Error: later execution failed",
      block("javascript", "second"),
      "after",
      OPEN + "js\nplain\n" + OPEN,
    ].join("\n");
    const folded = foldWorkflowMarkdown(source, false);
    assert.match(
      folded,
      /before\nWorkflow call · 2 lines \([^\n]*to expand\)\nmiddle/,
    );
    assert.match(folded, /Workflow call · 0 lines \([^\n]*to expand\)/);
    assert.equal((folded.match(/Workflow call/g) ?? []).length, 3);
    assert.match(folded, /Error: later execution failed/);
    assert.match(folded, new RegExp(OPEN + "js\\nplain\\n" + OPEN));
  });
  it("returns exact expanded source and skips user/thinking messages", () => {
    const source = block("js", "secret");
    assert.equal(foldWorkflowMarkdown(source, true), source);
    const transform = createWorkflowMarkdownTransformer(() => false);
    for (const messageType of ["user", "assistant-thinking"] as const) {
      assert.equal(
        transform(source, {
          messageType,
          isStreaming: true,
          availableWidth: 80,
        }),
        source,
      );
    }
  });
});
describe("actual assistant Markdown rendering", () => {
  it("invalidates cached Markdown for streaming, expansion, collapse, and restore", () => {
    let expanded = false;
    const transform = createWorkflowMarkdownTransformer(() => expanded);
    const folded = (text: string) => render(component(text, transform));
    const source = ["intro", block("js", "line one\nline two"), "tail"].join(
      "\n",
    );
    const value = component(source, transform);
    expanded = true;
    value.invalidate();
    assert.match(render(value), /line one|tail/);
    expanded = false;
    value.invalidate();
    assert.match(render(value), /Workflow call · 2 lines/);
    const streaming = component(
      OPEN + "javascript workflow\npartial",
      transform,
    );
    streaming.updateContent(
      assistant(OPEN + "javascript workflow\npartial"),
      true,
    );
    assert.doesNotMatch(render(streaming), /Workflow call/);
    streaming.updateContent(assistant(block("javascript", "partial")), true);
    assert.match(render(streaming), /Workflow call · 1 line/);
    assert.match(folded(source), /Workflow call · 2 lines/);
    const indented = [
      OPEN + "js workflow\nrun();\n  " + OPEN,
      "IMPORTANT: execution failed",
      OPEN + "js\nordinary();\n" + OPEN,
      "after",
    ].join("\n");
    assert.match(folded(indented), /Workflow call · 1 line/);
    assert.match(folded(indented), /IMPORTANT: execution failed/);
    assert.match(folded(indented), /ordinary\(\);/);
    assert.match(folded(indented), /after/);
    const html = "<pre>\n" + block("js", "secret") + "\n</pre>";
    assert.doesNotMatch(folded(html), /Workflow call/);
    const invalid = [
      OPEN + "text `literal`",
      "foo",
      OPEN,
      "",
      block("js", "example();"),
      block("js", "later();"),
    ].join("\n");
    assert.match(folded(invalid), /example\(\);/);
    assert.doesNotMatch(folded(invalid), /later\(\);/);
    assert.equal((folded(invalid).match(/Workflow call/g) ?? []).length, 1);
    assertRaw(
      OPEN + "js workflow\nbody",
      " " + OPEN + "js workflow\nbody\n" + OPEN,
      OPEN + "\ntail",
      OPEN + "python workflow\nbody\n" + OPEN,
      "~~~js workflow\nbody\n~~~",
      [OPEN + "markdown", block("js", "secret"), OPEN].join("\n"),
    );
    const crlf =
      OPEN +
      "js workflow\r\nline\r\n" +
      String.fromCharCode(96).repeat(4) +
      "\r\ntail";
    assert.match(
      foldWorkflowMarkdown(crlf, false),
      /Workflow call · 1 line[^\r\n]*\r\ntail/,
    );
  });
});
function integration(key: "ctrl+o" | "ctrl+e") {
  let toolsExpanded = false;
  let factory: any;
  let output = "";
  let invalidations = 0;
  let renders = 0;
  const state = { expanded: false };
  const value = component(
    block("js", "secret"),
    createWorkflowMarkdownTransformer(() => state.expanded),
  );
  const tui: any = {
    invalidate: () => {
      invalidations++;
      value.invalidate();
    },
    requestRender: () => {
      renders++;
      output = render(value);
    },
  };
  const events = new Map<string, any>();
  const listeners = new Set<(data: string) => void>();
  const pi: any = {
    on: (event: string, handler: any) => {
      events.set(event, handler);
      return () => events.delete(event);
    },
  };
  const ui: any = {
    getToolsExpanded: () => toolsExpanded,
    setEditorComponent: (editorFactory: any) => (factory = editorFactory),
    onTerminalInput: (listener: (data: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addAutocompleteProvider: () => undefined,
    notify: () => undefined,
  };
  registerCommandFilter(pi, (expanded) => (state.expanded = expanded));
  events.get("session_start")!({}, { hasUI: true, mode: "tui", ui });
  const editor = factory(
    tui,
    {},
    new KeybindingsManager(APP_KEYBINDINGS, { "app.tools.expand": key }),
  );
  editor.onChange = () => undefined;
  editor.onAction("app.tools.expand", () => (toolsExpanded = !toolsExpanded));
  output = render(value);
  const data = key === "ctrl+o" ? "\x0f" : "\x05";
  return {
    editor,
    selector: new ExtensionSelectorComponent(
      "extensions",
      ["one"],
      () => undefined,
      () => undefined,
      {
        onToggleToolsExpanded: () => (toolsExpanded = !toolsExpanded),
      },
    ),
    output: () => output,
    counts: () => ({ invalidations, renders }),
    async dispatch(focused: { handleInput(data: string): void }) {
      listeners.forEach((listener) => listener(data));
      focused.handleInput(data);
      await Promise.resolve();
    },
    shutdown: () => events.get("session_shutdown")?.({}, ui),
  };
}
describe("native expansion focus paths", () => {
  it("keeps editor dispatch, remaps keys, updates selectors, and cleans up", async () => {
    const previous = getKeybindings();
    try {
      for (const key of ["ctrl+o", "ctrl+e"] as const) {
        setKeybindings(
          new KeybindingsManager(APP_KEYBINDINGS, { "app.tools.expand": key }),
        );
        const harness = integration(key);
        harness.editor.handleInput("x");
        assert.equal(harness.editor.getText(), "x");
        await harness.dispatch(harness.editor);
        assert.match(harness.output(), /secret/);
        assert.deepEqual(harness.counts(), { invalidations: 1, renders: 1 });
        await harness.dispatch(harness.selector);
        assert.match(harness.output(), /Workflow call · 1 line/);
        assert.deepEqual(harness.counts(), { invalidations: 2, renders: 2 });
        await harness.dispatch(harness.selector);
        assert.match(harness.output(), /secret/);
        const beforeShutdown = harness.counts();
        harness.shutdown();
        await harness.dispatch(harness.selector);
        assert.deepEqual(harness.counts(), beforeShutdown);
      }
    } finally {
      setKeybindings(previous);
    }
  });
});
