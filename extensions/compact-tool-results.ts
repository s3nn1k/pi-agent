import * as nodePath from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  getLanguageFromPath,
  highlightCode,
  keyHint,
  renderDiff,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { hyperlink, Text, truncateToWidth } from "@earendil-works/pi-tui";

type AnyToolDefinition = ToolDefinition<any, any, any>;

type AnyRenderContext = {
  args: unknown;
  state: Record<string, unknown>;
  cwd: string;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  showImages: boolean;
  lastComponent: unknown;
  invalidate: () => void;
};
type ToolResultContent = AgentToolResult<any>["content"];
type ToolResultDetails =
  | {
      diff?: string;
      fullOutputPath?: string;
      matchLimitReached?: number;
      linesTruncated?: boolean;
      entryLimitReached?: number;
      resultLimitReached?: number;
      truncation?: {
        truncated?: boolean;
        truncatedBy?: "lines" | "bytes";
        outputLines?: number;
        totalLines?: number;
        maxBytes?: number;
        maxLines?: number;
        firstLineExceedsLimit?: boolean;
      };
    }
  | undefined;

type OutputExtractor = (
  result: AgentToolResult<any>,
  theme: Theme,
  context: AnyRenderContext,
) => { text: string; expanded: string; hiddenLines?: number };

function collectTextOutput(content: ToolResultContent): string {
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof (block as any).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .replace(/\n+$/, "");
}

function stripFullOutputFooter(
  output: string,
  details: ToolResultDetails,
  isPartial: boolean,
): string {
  if (
    !isPartial &&
    details?.truncation?.truncated &&
    details?.fullOutputPath &&
    output.endsWith("]")
  ) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (
      footerStart !== -1 &&
      output.slice(footerStart).includes(details.fullOutputPath)
    ) {
      return output.slice(0, footerStart).replace(/\n+$/, "");
    }
  }
  return output;
}

function collectDetailsWarnings(details: ToolResultDetails): string[] {
  const warnings: string[] = [];
  if (details?.fullOutputPath) {
    warnings.push(`Full output: ${details.fullOutputPath}`);
  }
  const truncation = details?.truncation;
  if (truncation?.truncated) {
    if (truncation.firstLineExceedsLimit) {
      warnings.push(
        `First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`,
      );
    } else if (truncation.truncatedBy === "bytes") {
      warnings.push(
        `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
      );
    } else if (
      truncation.outputLines !== undefined &&
      truncation.totalLines !== undefined
    ) {
      warnings.push(
        `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
      );
    }
  }
  if (details?.matchLimitReached) {
    warnings.push(`${details.matchLimitReached} matches limit`);
  }
  if (details?.linesTruncated) {
    warnings.push("some lines truncated");
  }
  if (details?.entryLimitReached) {
    warnings.push(`${details.entryLimitReached} entries limit`);
  }
  if (details?.resultLimitReached) {
    warnings.push(`${details.resultLimitReached} results limit`);
  }
  return warnings;
}

function styleAsToolOutput(text: string, theme: Theme): string {
  return text
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
}

function defaultOutput(
  result: AgentToolResult<any>,
  theme: Theme,
  context: AnyRenderContext,
): { text: string; expanded: string } {
  const text = stripFullOutputFooter(
    collectTextOutput(result.content),
    result.details as ToolResultDetails,
    context.isPartial,
  );
  return { text, expanded: styleAsToolOutput(text, theme) };
}

function editOutput(
  result: AgentToolResult<any>,
  theme: Theme,
): { text: string; expanded: string } {
  const summary = collectTextOutput(result.content);
  const diff = (result.details as ToolResultDetails)?.diff ?? "";
  return {
    text: [summary, diff].filter(Boolean).join("\n"),
    expanded: [
      summary ? styleAsToolOutput(summary, theme) : "",
      diff ? renderDiff(diff) : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function writeOutput(
  result: AgentToolResult<any>,
  theme: Theme,
  context: AnyRenderContext,
): { text: string; expanded: string; hiddenLines: number } {
  const text = collectTextOutput(result.content);
  const argsContent =
    typeof (context.args as { content?: unknown } | undefined)?.content ===
    "string"
      ? (context.args as { content: string }).content
      : "";
  const hiddenLines =
    argsContent === "" ? 0 : argsContent.replace(/\n+$/, "").split("\n").length;
  return { text, expanded: styleAsToolOutput(text, theme), hiddenLines };
}

function buildResultBody(
  result: AgentToolResult<any>,
  output: { text: string; expanded: string; hiddenLines?: number },
  options: ToolRenderResultOptions,
  theme: Theme,
  context: AnyRenderContext,
): string {
  if (options.expanded) {
    const segments: string[] = [];
    if (output.expanded) {
      segments.push(output.expanded);
    }
    const warnings = collectDetailsWarnings(
      result.details as ToolResultDetails,
    );
    if (context.isError) {
      warnings.unshift("Error result");
    }
    if (warnings.length > 0) {
      segments.push(theme.fg("warning", `[${warnings.join(". ")}]`));
    }
    return segments.join("\n");
  }
  const lineCount =
    (output.text === "" ? 0 : output.text.split("\n").length) +
    (output.hiddenLines ?? 0);
  if (lineCount === 0 && !context.isError) {
    return "";
  }
  const label = context.isError
    ? "error"
    : `${lineCount} line${lineCount === 1 ? "" : "s"}`;
  return theme.fg(
    "muted",
    `\n... (${label}, ${keyHint("app.tools.expand", "to expand")})`,
  );
}

function makeCompactResultRenderer(extractOutput: OutputExtractor) {
  return (
    result: AgentToolResult<any>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: AnyRenderContext,
  ): Text => {
    const body =
      (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    body.setText(
      buildResultBody(
        result,
        extractOutput(result, theme, context),
        options,
        theme,
        context,
      ),
    );
    return body;
  };
}

function displayPath(rawPath: string, cwd: string): string {
  const absolutePath = nodePath.isAbsolute(rawPath)
    ? rawPath
    : nodePath.resolve(cwd, rawPath);
  const cwdPrefix = cwd.endsWith(nodePath.sep) ? cwd : cwd + nodePath.sep;
  return absolutePath.startsWith(cwdPrefix)
    ? absolutePath.slice(cwdPrefix.length)
    : rawPath;
}

function bashCommandFromArgs(args: unknown): string {
  return typeof (args as { command?: unknown } | undefined)?.command ===
    "string"
    ? (args as { command: string }).command
    : "";
}

class CachedLineView {
  private line = "";
  private ellipsis = "...";
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  setLine(line: string, ellipsis: string): void {
    if (line !== this.line || ellipsis !== this.ellipsis) {
      this.line = line;
      this.ellipsis = ellipsis;
      this.cachedWidth = -1;
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) {
      const truncated = truncateToWidth(this.line, width, this.ellipsis);
      this.cachedLines = [truncated.replaceAll("\x1b[0m", "\x1b[39m")];
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }
}

function formatBashTimeoutSuffix(args: unknown, theme: Theme): string {
  const timeout = (args as { timeout?: unknown } | undefined)?.timeout;
  return typeof timeout === "number" && timeout > 0
    ? theme.fg("muted", ` (timeout ${timeout}s)`)
    : "";
}

function compactBashCall(
  args: unknown,
  theme: Theme,
  context: AnyRenderContext,
): Text | CachedLineView {
  const command = bashCommandFromArgs(args);
  const prompt = theme.fg("toolTitle", theme.bold("$"));
  const timeoutSuffix = formatBashTimeoutSuffix(args, theme);
  if (context.expanded) {
    const text =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
    const commandDisplay = command
      ? theme.fg("toolTitle", theme.bold(command))
      : theme.fg("toolOutput", "...");
    text.setText(`${prompt} ${commandDisplay}${timeoutSuffix}`);
    return text;
  }
  const firstLine = command.split("\n")[0] ?? "";
  const totalLines = command === "" ? 0 : command.split("\n").length;
  const extraSuffix =
    totalLines > 1
      ? theme.fg(
          "muted",
          ` (+${totalLines - 1} line${totalLines === 2 ? "" : "s"})`,
        )
      : "";
  const view =
    (context.state.bashCallView as CachedLineView | undefined) ??
    new CachedLineView();
  view.setLine(
    `${prompt} ${theme.fg("toolTitle", theme.bold(firstLine))}${extraSuffix}${timeoutSuffix}`,
    theme.fg("toolTitle", theme.bold("...")),
  );
  context.state.bashCallView = view;
  return view;
}

function bashOutput(
  result: AgentToolResult<any>,
  theme: Theme,
  context: AnyRenderContext,
): { text: string; expanded: string; hiddenLines: number } {
  const text = stripFullOutputFooter(
    collectTextOutput(result.content),
    result.details as ToolResultDetails,
    context.isPartial,
  );
  const command = bashCommandFromArgs(context.args);
  const commandLines = command === "" ? 0 : command.split("\n").length;
  return {
    text,
    expanded: styleAsToolOutput(text, theme),
    hiddenLines: Math.max(0, commandLines - 1),
  };
}

function formatToolPathHeader(
  toolLabel: string,
  rawPath: string,
  theme: Theme,
  cwd: string,
): string {
  const label = theme.fg("toolTitle", theme.bold(toolLabel));
  if (!rawPath) {
    return `${label} ${theme.fg("toolOutput", "...")}`;
  }
  const absolutePath = nodePath.isAbsolute(rawPath)
    ? rawPath
    : nodePath.resolve(cwd, rawPath);
  return `${label} ${hyperlink(theme.fg("toolTitle", displayPath(rawPath, cwd)), `file://${absolutePath}`)}`;
}

function formatEditCall(
  args: { path?: unknown },
  theme: Theme,
  cwd: string,
): string {
  const rawPath = typeof args?.path === "string" && args.path ? args.path : "";
  return formatToolPathHeader("edit", rawPath, theme, cwd);
}

function compactEditCall(
  args: unknown,
  theme: Theme,
  context: AnyRenderContext,
): Text {
  const header =
    (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  header.setText(
    formatEditCall(args as { path?: unknown }, theme, context.cwd),
  );
  return header;
}

function renderWriteContent(
  state: Record<string, unknown>,
  rawPath: string,
  content: string,
  theme: Theme,
): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "")
    .replace(/\t/g, "  ");
  const cacheKey = `${rawPath}\u0000${normalized}`;
  const cache = state.highlightCache as
    { key: string; rendered: string } | undefined;
  if (cache?.key === cacheKey) {
    return cache.rendered;
  }
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  const rendered = lang
    ? highlightCode(normalized, lang).join("\n")
    : styleAsToolOutput(normalized, theme);
  state.highlightCache = { key: cacheKey, rendered };
  return rendered;
}

function formatWriteCall(
  args: WriteCallArgs,
  theme: Theme,
  context: AnyRenderContext,
): string {
  const rawPath =
    typeof (args?.path ?? args?.file_path) === "string"
      ? String(args.path ?? args.file_path)
      : "";
  const content = typeof args?.content === "string" ? args.content : "";
  const header = formatToolPathHeader("write", rawPath, theme, context.cwd);
  if (!content || !context.expanded) {
    return header;
  }
  return `${header}\n${renderWriteContent(context.state, rawPath, content, theme)}`;
}

type WriteCallArgs = { path?: unknown; file_path?: unknown; content?: unknown };

function compactWriteCall(
  args: unknown,
  theme: Theme,
  context: AnyRenderContext,
): Text {
  const header =
    (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  header.setText(formatWriteCall(args as WriteCallArgs, theme, context));
  return header;
}

function registerCompactTool(
  pi: ExtensionAPI,
  definition: AnyToolDefinition,
  extractOutput?: OutputExtractor,
  renderCall?: AnyToolDefinition["renderCall"],
): void {
  pi.registerTool({
    ...definition,
    renderShell: "default",
    ...(renderCall ? { renderCall } : {}),
    renderResult: makeCompactResultRenderer(extractOutput ?? defaultOutput),
  } as AnyToolDefinition);
}

export default function compactToolResults(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  registerCompactTool(
    pi,
    createBashToolDefinition(cwd),
    bashOutput,
    compactBashCall,
  );
  registerCompactTool(pi, createReadToolDefinition(cwd));
  registerCompactTool(
    pi,
    createWriteToolDefinition(cwd),
    writeOutput,
    compactWriteCall,
  );
  registerCompactTool(pi, createGrepToolDefinition(cwd));
  registerCompactTool(pi, createFindToolDefinition(cwd));
  registerCompactTool(pi, createLsToolDefinition(cwd));
  registerCompactTool(
    pi,
    createEditToolDefinition(cwd),
    editOutput,
    compactEditCall,
  );
}
