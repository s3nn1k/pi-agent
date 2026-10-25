import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getActiveQuotaProviders,
  getQuotaEntry,
  refreshQuotas,
} from "../lib/quota/cache";
import {
  isWindowPinged,
  loadState,
  needsPing,
  pickModel,
  reportLine,
  saveState,
  windowKey,
  type ColdStartState,
} from "./logic.ts";

const PING_TIMEOUT_MS = 30_000;
const PING_MAX_TOKENS = 16;

interface WarmupOutcome {
  warmed: string[];
  errors: string[];
}

type ProviderOutcome = { kind: "warmed" } | { kind: "failed"; message: string };

function statePath(): string {
  return join(getAgentDir(), "cold-start.json");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyWarmup(ctx: ExtensionContext, outcome: WarmupOutcome): void {
  try {
    if (!ctx.hasUI) return;
    if (outcome.warmed.length > 0) {
      ctx.ui.notify(outcome.warmed.join("\n"), "info");
    }
    if (outcome.errors.length > 0) {
      ctx.ui.notify(outcome.errors.join("\n"), "error");
    }
  } catch {}
}

async function pingModel(
  ctx: ExtensionContext,
  providerId: string,
  signal: AbortSignal,
): Promise<void> {
  const models = ctx.modelRegistry
    .getModelsOfType("chat", providerId)
    .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
  const model = pickModel(models);
  if (!model) throw new Error("no usable model");

  const response = await ctx.modelRegistry.complete(
    model,
    {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "ping" }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: PING_MAX_TOKENS,
      maxRetries: 0,
      cacheRetention: "none",
      signal,
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? response.stopReason);
  }
}

async function warmProvider(
  ctx: ExtensionContext,
  providerId: string,
  state: ColdStartState,
  sessionSignal: AbortSignal,
): Promise<ProviderOutcome | undefined> {
  const entry = getQuotaEntry(providerId);
  if (!entry) return undefined;
  const windows = entry.snapshot.windows;
  const now = Date.now();
  const sleeping =
    entry.error !== undefined ||
    windows.length === 0 ||
    needsPing(windows, now);
  if (!sleeping || isWindowPinged(state[providerId], windows, now)) {
    return undefined;
  }

  try {
    await pingModel(
      ctx,
      providerId,
      AbortSignal.any([sessionSignal, AbortSignal.timeout(PING_TIMEOUT_MS)]),
    );
  } catch (error) {
    if (sessionSignal.aborted) return undefined;
    return { kind: "failed", message: errorMessage(error) };
  }

  await refreshQuotas(ctx, sessionSignal, { maxAgeMs: 0 });
  const freshWindows = getQuotaEntry(providerId)?.snapshot.windows ?? [];
  state[providerId] = {
    windowKey: windowKey(freshWindows, Date.now()),
    pingedAtMs: Date.now(),
  };
  await saveState(statePath(), state);
  return { kind: "warmed" };
}

async function runWarmup(
  ctx: ExtensionContext,
  sessionSignal: AbortSignal,
): Promise<WarmupOutcome> {
  await refreshQuotas(ctx, sessionSignal);
  const state = await loadState(statePath());
  const outcome: WarmupOutcome = { warmed: [], errors: [] };
  for (const provider of getActiveQuotaProviders(ctx)) {
    const result = await warmProvider(ctx, provider.id, state, sessionSignal);
    if (!result) continue;
    if (result.kind === "warmed") {
      outcome.warmed.push(reportLine(provider.id, "warmed"));
    } else {
      outcome.errors.push(reportLine(provider.id, result.message));
    }
  }
  return outcome;
}

export default function coldStart(pi: ExtensionAPI) {
  let warmupAbort: AbortController | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    warmupAbort?.abort();
    const controller = new AbortController();
    warmupAbort = controller;
    void runWarmup(ctx, controller.signal)
      .then((outcome) => notifyWarmup(ctx, outcome))
      .catch((error) =>
        notifyWarmup(ctx, {
          warmed: [],
          errors: [`cold-start: ${errorMessage(error)}`],
        }),
      );
  });

  pi.on("session_shutdown", () => {
    warmupAbort?.abort();
    warmupAbort = undefined;
  });
}
