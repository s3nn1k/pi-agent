import {
  keyText,
  type ExtensionAPI,
  type MarkdownTransformer,
} from "@earendil-works/pi-coding-agent";
import { Marked } from "@earendil-works/pi-tui";
type WorkflowSpan = [startLine: number, closingLine: number, lineCount: number];

const MARKDOWN = new Marked();
const WORKFLOW_OPEN = /^\`\`\`(?:js|javascript) workflow[ \t]*$/;
const CLOSE_FENCE = /^ {0,3}(\`{3,})[ \t]*$/;
function workflowSpans(markdown: string): WorkflowSpan[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const tokens = MARKDOWN.lexer(normalized);
  const spans: WorkflowSpan[] = [];
  let cursor = 0;
  let line = 0;
  for (const token of tokens) {
    if (!normalized.startsWith(token.raw, cursor)) return [];
    cursor += token.raw.length;
    const rawLines = token.raw.split("\n");
    const startLine = line;
    line += rawLines.length - 1;
    if (token.type !== "code") continue;
    const closingLineText =
      rawLines.at(token.raw.endsWith("\n") ? -2 : -1) ?? "";
    if (
      !WORKFLOW_OPEN.test(rawLines[0] ?? "") ||
      !CLOSE_FENCE.test(closingLineText)
    ) {
      continue;
    }
    const closingLine =
      startLine + rawLines.length - 1 - (token.raw.endsWith("\n") ? 1 : 0);
    spans.push([startLine, closingLine, closingLine - startLine - 1]);
  }
  return cursor === normalized.length ? spans : [];
}
const workflowRow = (lineCount: number): string => {
  const key = keyText("app.tools.expand");
  const hint = key === "" ? "to expand" : `${key} to expand`;
  return `Workflow call · ${lineCount} ${lineCount === 1 ? "line" : "lines"} (${hint})`;
};
export function foldWorkflowMarkdown(
  markdown: string,
  expanded: boolean,
): string {
  if (expanded) return markdown;
  const lines = markdown
    .match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)
    ?.filter(Boolean) ?? [""];
  const spansByLine = new Map(
    workflowSpans(markdown).map((span) => [span[0], span]),
  );
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const span = spansByLine.get(index);
    if (span === undefined) {
      output.push(lines[index]!);
      index++;
      continue;
    }
    const ending = lines[span[1]]?.match(/\r\n|\n|\r$/)?.[0] ?? "";
    output.push(workflowRow(span[2]) + ending);
    index = span[1] + 1;
  }
  return output.join("");
}
export function createWorkflowMarkdownTransformer(
  getToolsExpanded: () => boolean,
): MarkdownTransformer {
  return (markdown, context) =>
    context.messageType === "assistant"
      ? foldWorkflowMarkdown(markdown, getToolsExpanded())
      : markdown;
}

export function registerWorkflowFolding(
  pi: ExtensionAPI,
  getToolsExpanded: () => boolean,
): void {
  pi.registerMarkdownTransformer(
    createWorkflowMarkdownTransformer(getToolsExpanded),
  );
}
