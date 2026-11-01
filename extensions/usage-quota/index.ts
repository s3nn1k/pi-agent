import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getActiveQuotaProviders,
  getQuotaEntry,
  refreshQuotas,
  type QuotaCacheEntry,
} from "../lib/quota/cache";
import type { QuotaProvider } from "../lib/quota/types";
import { createUsageFooter } from "./footer";
import { formatResetDateTime, severity } from "./format";

const UI_KEY = "usage-quota";

const STALE_AFTER_MS = 2 * 60_000;
const REFRESH_DEBOUNCE_MS = 3_000;
const TICK_MS = 30_000;

export default function (pi: ExtensionAPI) {
  let uiCtx: ExtensionContext | undefined;
  let tickTimer: NodeJS.Timeout | undefined;
  let refreshDebounce: NodeJS.Timeout | undefined;
  let refreshAbort: AbortController | undefined;
  let requestFooterRender: (() => void) | undefined;
  const notifiedError = new Set<string>();

  async function refresh(ctx: ExtensionContext): Promise<void> {
    await refreshQuotas(ctx, refreshAbort?.signal);
    syncErrorNotifications(ctx);
  }

  function syncErrorNotifications(ctx: ExtensionContext): void {
    for (const provider of getActiveQuotaProviders(ctx)) {
      const error = getQuotaEntry(provider.id)?.error;
      if (error && !notifiedError.has(provider.id)) {
        notifiedError.add(provider.id);
        try {
          ctx.ui.notify(`${provider.id} quota: ${error}`, "error");
        } catch {}
      } else if (!error) {
        notifiedError.delete(provider.id);
      }
    }
  }

  interface ProviderWithEntry {
    provider: QuotaProvider;
    entry: QuotaCacheEntry;
  }

  function quotaLines(ctx: ExtensionContext): string[] {
    const theme = ctx.ui.theme;
    const providers: ProviderWithEntry[] = getActiveQuotaProviders(ctx)
      .map((provider) => ({ provider, entry: getQuotaEntry(provider.id) }))
      .filter((item): item is ProviderWithEntry => item.entry !== undefined);
    const lines: string[] = [];
    for (const { provider, entry } of providers) {
      const fg = (color: "dim" | "muted" | "warning" | "error", text: string) =>
        theme.fg(entry.error ? "dim" : color, text);
      const now = Date.now();
      const providerLabel = `[${provider.id[0]}]`;
      const cells = entry.snapshot.windows.map((window) => {
        const reset =
          window.resetAtMs !== undefined && window.resetAtMs > now
            ? theme.fg("dim", `(${formatResetDateTime(window.resetAtMs, now)})`)
            : "";
        const roundedPercent = Math.round(window.usedPercent);
        const value = roundedPercent === 100 ? "f" : String(roundedPercent);
        return `${fg("muted", window.label)}:${fg(
          severity(window.label, window.usedPercent),
          value,
        )}${reset}`;
      });
      let line = fg("dim", providerLabel);
      if (cells.length > 0) line += ` ${cells.join(" ")}`;
      const peak = provider.getPeakState?.(now);
      if (peak?.active && peak.endsInMs !== undefined && peak.rate) {
        line += ` ${fg(
          "error",
          `${peak.rate}(${formatResetDateTime(now + peak.endsInMs, now)})`,
        )}`;
      }
      lines.push(line);
    }
    return lines;
  }

  function stopTimer(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
    refreshAbort = new AbortController();
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(UI_KEY, undefined);
    ctx.ui.setStatus(UI_KEY, undefined);
    if (ctx.mode !== "tui") return;

    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    ctx.ui.setFooter((tui, theme, footerData) => {
      const requestRender = () => tui.requestRender();
      requestFooterRender = requestRender;
      return createUsageFooter(
        tui,
        theme,
        footerData,
        ctx,
        settings.getCompactionEnabled(),
        () => pi.getThinkingLevel(),
        () => quotaLines(ctx),
        () => {
          if (requestFooterRender === requestRender) {
            requestFooterRender = undefined;
          }
        },
      );
    });

    stopTimer();
    tickTimer = setInterval(() => requestFooterRender?.(), TICK_MS);
    tickTimer.unref();
    requestFooterRender?.();
    void refresh(ctx).catch(() => {});
  });

  pi.on("message_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    uiCtx = ctx;
    const stale = getActiveQuotaProviders(ctx).some((provider) => {
      const entry = getQuotaEntry(provider.id);
      return !entry || Date.now() - entry.fetchedAtMs >= STALE_AFTER_MS;
    });
    if (!stale || refreshDebounce) return;
    refreshDebounce = setTimeout(() => {
      refreshDebounce = undefined;
      if (uiCtx) void refresh(uiCtx).catch(() => {});
    }, REFRESH_DEBOUNCE_MS);
    refreshDebounce.unref();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    refreshAbort?.abort();
    refreshAbort = undefined;
    stopTimer();
    if (refreshDebounce) {
      clearTimeout(refreshDebounce);
      refreshDebounce = undefined;
    }
    if (ctx.hasUI) {
      ctx.ui.setWidget(UI_KEY, undefined);
      ctx.ui.setStatus(UI_KEY, undefined);
      if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
    }
    requestFooterRender = undefined;
    uiCtx = undefined;
  });
}
