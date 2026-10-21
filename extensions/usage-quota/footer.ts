import { isAbsolute, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  type Component,
  visibleWidth,
} from "@earendil-works/pi-tui";

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate?: number;
}

interface FooterTui {
  requestRender(force?: boolean): void;
}

interface UsageValue {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const relativeToHome = relative(resolve(home), resolve(cwd));
  if (
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome))
  ) {
    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
  }
  return cwd;
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function addUsage(
  totals: UsageTotals,
  usage: UsageValue,
  updateCacheHitRate: boolean,
): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (updateCacheHitRate && promptTokens > 0) {
    totals.latestCacheHitRate = (usage.cacheRead / promptTokens) * 100;
  }
}

function sessionUsage(ctx: ExtensionContext): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        addUsage(totals, message.usage, true);
        continue;
      }
      if (message.role === "toolResult") {
        const usage = (message as { usage?: UsageValue }).usage;
        if (usage) addUsage(totals, usage, false);
      }
      continue;
    }
    if (entry.type === "branch_summary" || entry.type === "compaction") {
      const usage = (entry as { usage?: UsageValue }).usage;
      if (usage) addUsage(totals, usage, false);
    }
  }
  return totals;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function statsLine(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  width: number,
  autoCompactEnabled: boolean,
  getThinkingLevel: () => string,
): string {
  const totals = sessionUsage(ctx);
  const parts: string[] = [];
  if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
  if (
    (totals.cacheRead > 0 || totals.cacheWrite > 0) &&
    totals.latestCacheHitRate !== undefined
  ) {
    parts.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
  }

  const model = ctx.model;
  const usingSubscription = model
    ? ctx.modelRegistry.isUsingOAuth(model)
    : false;
  if (totals.cost || usingSubscription) {
    parts.push(
      `$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
    );
  }

  const context = ctx.getContextUsage();
  const contextWindow = context?.contextWindow ?? model?.contextWindow ?? 0;
  const contextPercent = context?.percent;
  const contextText = `${
    contextPercent === null || contextPercent === undefined
      ? "?"
      : `${contextPercent.toFixed(1)}%`
  }/${formatTokens(contextWindow)}${autoCompactEnabled ? " (auto)" : ""}`;
  if ((contextPercent ?? 0) > 90) {
    parts.push(theme.fg("error", contextText));
  } else if ((contextPercent ?? 0) > 70) {
    parts.push(theme.fg("warning", contextText));
  } else {
    parts.push(contextText);
  }

  let left = parts.join(" ");
  if (visibleWidth(left) > width) {
    left = truncateToWidth(left, width, "...");
  }

  const modelName = model?.id ?? "no-model";
  const thinkingLevelValue = getThinkingLevel();
  const thinkingLevel = model?.reasoning
    ? thinkingLevelValue === "off"
      ? " • thinking off"
      : ` • ${thinkingLevelValue}`
    : "";
  const modelWithThinking = `${modelName}${thinkingLevel}`;
  let right = modelWithThinking;
  if (model && footerData.getAvailableProviderCount() > 1) {
    const withProvider = `(${model.provider}) ${modelWithThinking}`;
    if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) {
      right = withProvider;
    }
  }

  const availableRightWidth = width - visibleWidth(left) - 2;
  if (availableRightWidth <= 0) return theme.fg("dim", left);
  right = truncateToWidth(right, availableRightWidth, "");
  const padding = " ".repeat(
    Math.max(0, width - visibleWidth(left) - visibleWidth(right)),
  );
  return theme.fg("dim", `${left}${padding}${right}`);
}

function baseFooterLines(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  width: number,
  autoCompactEnabled: boolean,
  getThinkingLevel: () => string,
): string[] {
  let cwd = formatCwd(
    ctx.sessionManager.getCwd(),
    process.env.HOME ?? process.env.USERPROFILE,
  );
  const branch = footerData.getGitBranch();
  if (branch) cwd += ` (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) cwd += ` • ${sessionName}`;

  const lines = [
    truncateToWidth(theme.fg("dim", cwd), width, theme.fg("dim", "...")),
    statsLine(
      ctx,
      footerData,
      theme,
      width,
      autoCompactEnabled,
      getThinkingLevel,
    ),
  ];
  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeStatusText(text));
  if (statuses.length > 0) {
    lines.push(
      truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")),
    );
  }
  return lines;
}

export function createUsageFooter(
  tui: FooterTui,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  ctx: ExtensionContext,
  autoCompactEnabled: boolean,
  getThinkingLevel: () => string,
  quotaLines: () => string[],
  onDispose: () => void,
): Component & { dispose(): void } {
  const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
  return {
    render(width: number): string[] {
      const quota = quotaLines().map((line) =>
        truncateToWidth(line, width, theme.fg("dim", "...")),
      );
      const lines = [
        ...baseFooterLines(
          ctx,
          footerData,
          theme,
          width,
          autoCompactEnabled,
          getThinkingLevel,
        ),
        ...quota,
      ];
      const containerized = existsSync("/.dockerenv");
      lines.push(
        theme.fg("dim", "containerized: ") +
          theme.fg(containerized ? "success" : "error", String(containerized)),
      );
      return lines;
    },
    invalidate(): void {},
    dispose(): void {
      unsubscribe();
      onDispose();
    },
  };
}
