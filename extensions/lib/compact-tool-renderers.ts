import {
  keyHint,
  type AgentToolResult,
  type Theme,
  type ToolRendererResolver,
  type ToolRenderResultOptions,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

interface CompactRendererState {
  compactCallComponent?: Component;
  compactResultComponent?: Component;
  nativeCallComponent?: Component;
  nativeResultComponent?: Component;
  fallbackCallComponent?: Component;
  fallbackResultComponent?: Component;
  nativeCallErrorReported?: boolean;
  nativeResultErrorReported?: boolean;
  compactStartedAt?: number;
}

interface AnyRenderContext {
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
type AnyToolResult = AgentToolResult<any>;
type RendererKind = "codemode" | "mcp";

const SCRIPT_HEADER =
  /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function stateFor(context: AnyRenderContext): CompactRendererState {
  return context.state as CompactRendererState;
}

function startCompactTimer(context: AnyRenderContext): void {
  const state = stateFor(context);
  if (context.executionStarted && state.compactStartedAt === undefined) {
    state.compactStartedAt = Date.now();
  }
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${Math.round(milliseconds)}ms`
    : `${(milliseconds / 1000).toFixed(1)}s`;
}

function durationText(
  context: AnyRenderContext,
  isPartial: boolean,
): string | undefined {
  if (!isPartial && context.durationMs !== undefined) {
    return `Took ${formatDuration(context.durationMs)}`;
  }
  const startedAt = stateFor(context).compactStartedAt;
  if (startedAt === undefined) {
    return undefined;
  }
  return `${isPartial ? "Elapsed" : "Took"} ${formatDuration(Date.now() - startedAt)}`;
}

function titleFor(toolName: string, kind: RendererKind): string {
  if (kind === "codemode") {
    return "codemode";
  }
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? `${match[1]}/${match[2]}` : toolName;
}

function compactCallComponent(
  title: string,
  theme: Theme,
  previous: Component | undefined,
): Text {
  const component = previous instanceof Text ? previous : new Text("", 0, 0);
  component.setText(theme.fg("toolTitle", theme.bold(title)));
  return component;
}

function fallbackExpandedCall(
  title: string,
  args: unknown,
  theme: Theme,
  previous: Component | undefined,
): Text {
  const component = previous instanceof Text ? previous : new Text("", 0, 0);
  const serialized = JSON.stringify(args, null, 2);
  component.setText(
    `${theme.fg("toolTitle", theme.bold(title))}${serialized ? `\n${theme.fg("muted", serialized)}` : ""}`,
  );
  return component;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : [],
  );
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.filter(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "image",
  ).length;
}

function resultText(result: AnyToolResult, kind: RendererKind): string {
  const blocks = textBlocks(result.content);
  if (
    kind === "codemode" &&
    blocks.length > 0 &&
    SCRIPT_HEADER.test(blocks[0])
  ) {
    blocks.shift();
  }
  return blocks.join("\n").replace(/\n+$/, "");
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function nestedCallCounts(result: AnyToolResult, theme: Theme): string[] {
  const details = result.details;
  const calls =
    typeof details === "object" &&
    details !== null &&
    Array.isArray((details as { calls?: unknown }).calls)
      ? (details as { calls: Array<{ status?: unknown }> }).calls
      : [];
  const counts = new Map<string, number>();
  for (const call of calls) {
    if (call.status === "error") {
      counts.set("error", (counts.get("error") ?? 0) + 1);
    } else if (call.status === "cancelled") {
      counts.set("cancelled", (counts.get("cancelled") ?? 0) + 1);
    } else if (call.status === "running") {
      counts.set("running", (counts.get("running") ?? 0) + 1);
    }
  }
  return ["error", "cancelled", "running"]
    .filter((status) => counts.has(status))
    .map((status) => {
      const text = `${counts.get(status)} ${status}`;
      const color =
        status === "error"
          ? "error"
          : status === "cancelled"
            ? "warning"
            : "muted";
      return theme.fg(color, text);
    });
}

interface CompactResultParams {
  toolName: string;
  kind: RendererKind;
  result: AnyToolResult;
  options: ToolRenderResultOptions;
  theme: Theme;
  context: AnyRenderContext;
}

function compactResultText(params: CompactResultParams): string {
  const { toolName, kind, result, options, theme, context } = params;
  const output = resultText(result, kind);
  const status = context.isError
    ? theme.fg("error", "error")
    : options.isPartial
      ? theme.fg("warning", "running")
      : theme.fg("success", "ok");
  const imageTotal = imageCount(result.content);
  const count =
    kind === "codemode"
      ? (() => {
          const details = result.details;
          const calls =
            typeof details === "object" &&
            details !== null &&
            Array.isArray((details as { calls?: unknown }).calls)
              ? (details as { calls: unknown[] }).calls.length
              : 0;
          return plural(calls, "call");
        })()
      : `${plural(lineCount(output), "line")}${imageTotal > 0 ? `, ${plural(imageTotal, "image")}` : ""}`;
  const parts = [status, count];
  if (kind === "codemode") {
    parts.push(
      `${lineCount(output)} ${lineCount(output) === 1 ? "line" : "lines"}`,
    );
    parts.push(...nestedCallCounts(result, theme));
  }
  const duration = durationText(context, options.isPartial);
  if (duration) {
    parts.push(duration);
  }
  parts.push(`(${keyHint("app.tools.expand", "to expand")})`);
  return `${titleFor(toolName, kind)} ${parts.join(", ")}`;
}

function fallbackExpandedResult(
  result: AnyToolResult,
  theme: Theme,
  context: AnyRenderContext,
  previous: Component | undefined,
): Text {
  const component = previous instanceof Text ? previous : new Text("", 0, 0);
  const text = textBlocks(result.content).join("\n").replace(/\n+$/, "");
  const images = imageCount(result.content);
  const content = [text, images > 0 ? `[${plural(images, "image")}]` : ""]
    .filter(Boolean)
    .join("\n");
  const fallback = content || (context.isError ? "Error result" : "No output");
  const color = context.isError ? "error" : "toolOutput";
  component.setText(theme.fg(color, fallback));
  return component;
}

function nativeContext(
  context: AnyRenderContext,
  lastComponent: Component | undefined,
): AnyRenderContext {
  return { ...context, lastComponent };
}

function reportNativeRendererError(
  state: CompactRendererState,
  toolName: string,
  rendererKind: "call" | "result",
  error: unknown,
): void {
  const reportKey =
    rendererKind === "call"
      ? "nativeCallErrorReported"
      : "nativeResultErrorReported";
  if (state[reportKey]) {
    return;
  }
  state[reportKey] = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `compact-tool-results: ${toolName} native ${rendererKind} renderer failed; using fallback: ${message}`,
  );
}

function createWrappedRenderers(
  toolName: string,
  kind: RendererKind,
  native: ToolRenderers | undefined,
): ToolRenderers {
  const title = titleFor(toolName, kind);
  return {
    ...(native?.renderShell ? { renderShell: native.renderShell } : {}),
    renderCall(args, theme, context) {
      startCompactTimer(context);
      const state = stateFor(context);
      if (context.expanded && native?.renderCall) {
        try {
          const component = native.renderCall(
            args,
            theme,
            nativeContext(context, state.nativeCallComponent),
          );
          state.nativeCallComponent = component;
          return component;
        } catch (error) {
          state.nativeCallComponent = undefined;
          reportNativeRendererError(state, toolName, "call", error);
        }
      }
      if (context.expanded) {
        const component = fallbackExpandedCall(
          title,
          args,
          theme,
          state.fallbackCallComponent,
        );
        state.fallbackCallComponent = component;
        return component;
      }
      const component = compactCallComponent(
        title,
        theme,
        state.compactCallComponent,
      );
      state.compactCallComponent = component;
      return component;
    },
    renderResult(result, options, theme, context) {
      const state = stateFor(context);
      if (options.expanded && native?.renderResult) {
        try {
          const component = native.renderResult(
            result,
            options,
            theme,
            nativeContext(context, state.nativeResultComponent),
          );
          state.nativeResultComponent = component;
          return component;
        } catch (error) {
          state.nativeResultComponent = undefined;
          reportNativeRendererError(state, toolName, "result", error);
        }
      }
      if (options.expanded) {
        const component = fallbackExpandedResult(
          result,
          theme,
          context,
          state.fallbackResultComponent,
        );
        state.fallbackResultComponent = component;
        return component;
      }
      const component =
        state.compactResultComponent instanceof Text
          ? state.compactResultComponent
          : new Text("", 0, 0);
      component.setText(
        compactResultText({
          toolName,
          kind,
          result,
          options,
          theme,
          context,
        }),
      );
      state.compactResultComponent = component;
      return component;
    },
  };
}

export function createCompactToolRendererResolver(): ToolRendererResolver {
  return (toolName, next) => {
    const kind: RendererKind | undefined =
      toolName === "codemode"
        ? "codemode"
        : toolName.startsWith("mcp__")
          ? "mcp"
          : undefined;
    if (!kind) {
      return next();
    }
    return createWrappedRenderers(toolName, kind, next());
  };
}
