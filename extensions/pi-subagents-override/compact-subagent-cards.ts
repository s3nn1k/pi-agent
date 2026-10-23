import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { contentTextOf, expandHint, plural } from "../lib/compact-render.ts";

const CONTROL_NOTICE_TYPE = "subagent_control_notice";
const SUPERVISOR_REQUEST_TYPE = "subagent_supervisor_request";
const SUPERVISOR_REPLY_ENTRY_TYPE = "subagent_supervisor_reply";

type CardMessage = { content?: unknown; details?: unknown };
type CardEntry = { data?: unknown };
type Card = { heading: string; bodyLines: string[] };

function sanitizeText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

class CollapsedCardLine implements Component {
  private readonly line: string;
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  constructor(line: string) {
    this.line = line;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) {
      this.cachedLines = [
        truncateToWidth(this.line, width, "...").replaceAll(
          "\x1b[0m",
          "\x1b[39m",
        ),
      ];
      this.cachedWidth = width;
    }
    return this.cachedLines;
  }
}

class ExpandedCard implements Component {
  private readonly heading: string;
  private readonly bodyLines: string[];
  private readonly theme: Theme;

  constructor(heading: string, bodyLines: string[], theme: Theme) {
    this.heading = heading;
    this.bodyLines = bodyLines;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 3) {
      return [truncateToWidth(this.heading, width, "")];
    }
    const bodyWidth = width - 2;
    const border = (text: string) => this.theme.fg("accent", text);
    const headerText = truncateToWidth(` ${this.heading} `, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    const lines = [border(`╭${headerText}${"─".repeat(headerPadding)}╮`)];
    for (const bodyLine of this.bodyLines) {
      const wrapped = wrapTextWithAnsi(bodyLine, Math.max(1, bodyWidth));
      for (const wrappedLine of wrapped.length > 0 ? wrapped : [""]) {
        const text = truncateToWidth(wrappedLine, bodyWidth, "");
        lines.push(
          border(
            `│${text}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(text)))}│`,
          ),
        );
      }
    }
    lines.push(border(`╰${"─".repeat(bodyWidth)}╯`));
    return lines;
  }
}

function controlCard(message: CardMessage): Card | undefined {
  const details = asRecord(message.details);
  const event = asRecord(details?.event);
  const body = sanitizeText(
    stringField(details, "noticeText") || contentTextOf(message.content),
  );
  const eventType = stringField(event, "type").replaceAll("_", " ");
  const agent = stringField(event, "agent");
  if (eventType === "" && agent === "" && body === "") {
    return undefined;
  }
  const heading = `⚠ Subagent ${eventType || "notice"}${agent ? `: ${agent}` : ""}`;
  return { heading, bodyLines: body === "" ? [] : body.split("\n") };
}

function supervisorRequestCard(message: CardMessage): Card | undefined {
  const details = asRecord(message.details);
  const requestBody = sanitizeText(
    stringField(details, "requestBody") || contentTextOf(message.content),
  );
  const requestId =
    stringField(details, "requestId") || stringField(details, "id");
  if (details === undefined || (requestId === "" && requestBody === "")) {
    return undefined;
  }
  const reason = stringField(details, "reason");
  const heading =
    reason === "interview_request"
      ? "⚠ Supervisor interview request"
      : reason === "progress_update"
        ? "ℹ Supervisor progress update"
        : "⚠ Supervisor decision request";
  const lines: string[] = [`Reason: ${reason || "unknown"}`];
  const runId = stringField(details, "runId");
  if (runId) {
    lines.push(`Run: ${runId}`);
  }
  const agent = stringField(details, "agent");
  if (agent) {
    lines.push(`Agent: ${agent}`);
  }
  if (typeof details.childIndex === "number") {
    lines.push(`Child index: ${details.childIndex}`);
  }
  const childTarget = stringField(details, "childTarget");
  if (childTarget) {
    lines.push(`Child target: ${childTarget}`);
  }
  if (requestId) {
    lines.push(`Request ID: ${requestId}`);
  }
  if (details.expectsReply === true) {
    const replyHint =
      stringField(details, "replyHint") ||
      `subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`;
    lines.push(`Reply with: ${replyHint}`);
  }
  lines.push("", "Request:", requestBody || "(no request body)");
  if (details.interview !== undefined) {
    let interviewText = "[unavailable]";
    try {
      interviewText =
        JSON.stringify(details.interview, null, 2) ?? String(details.interview);
    } catch {
      interviewText = "[unavailable]";
    }
    lines.push("", "Interview shape:", sanitizeText(interviewText));
  }
  return { heading, bodyLines: lines };
}

function supervisorReplyCard(entry: CardEntry): Card | undefined {
  const data = asRecord(entry.data);
  if (data === undefined) {
    return undefined;
  }
  const message = sanitizeText(stringField(data, "message"));
  const agent = stringField(data, "agent");
  const requestId = stringField(data, "requestId");
  if (message === "" && agent === "" && requestId === "") {
    return undefined;
  }
  const lines: string[] = [];
  const runId = stringField(data, "runId");
  if (runId) {
    lines.push(`Run: ${runId}`);
  }
  if (agent) {
    lines.push(`Agent: ${agent}`);
  }
  if (typeof data.childIndex === "number") {
    lines.push(`Child index: ${data.childIndex}`);
  }
  const childTarget = stringField(data, "childTarget");
  if (childTarget) {
    lines.push(`Child target: ${childTarget}`);
  }
  if (requestId) {
    lines.push(`Reply to: ${requestId}`);
  }
  lines.push("", "Reply:", message || "(empty reply)");
  return {
    heading: `↩ Supervisor reply${agent ? `: ${agent}` : ""}`,
    bodyLines: lines,
  };
}

function compactCardRenderer(
  build: (source: CardMessage & CardEntry) => Card | undefined,
): (
  source: unknown,
  options: { expanded: boolean },
  theme: Theme,
) => Component | undefined {
  return (source, options, theme) => {
    const card = build(source as CardMessage & CardEntry);
    if (!card) {
      return undefined;
    }
    if (options.expanded) {
      return new ExpandedCard(card.heading, card.bodyLines, theme);
    }
    const hiddenLines = card.bodyLines.length;
    const hint =
      hiddenLines > 0
        ? ` (+${plural(hiddenLines, "line")}, ${expandHint()} to expand)`
        : "";
    return new CollapsedCardLine(
      theme.fg("accent", theme.bold(card.heading)) + theme.fg("muted", hint),
    );
  };
}

export default function compactSubagentCards(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(
    CONTROL_NOTICE_TYPE,
    compactCardRenderer(controlCard),
  );
  pi.registerMessageRenderer(
    SUPERVISOR_REQUEST_TYPE,
    compactCardRenderer(supervisorRequestCard),
  );
  pi.registerEntryRenderer(
    SUPERVISOR_REPLY_ENTRY_TYPE,
    compactCardRenderer(supervisorReplyCard),
  );
}
