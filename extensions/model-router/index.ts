import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRoute,
  type ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import {
  getActiveQuotaProviders,
  getQuotaEntry,
  isProviderBroken,
  markProviderBroken,
  refreshQuotas,
  type QuotaCacheEntry,
} from "../lib/quota/cache";
import {
  blindFallbackProvider,
  keepStickyProvider,
  leaveReason,
  metricsFromWindows,
  parseCandidateString,
  selectProvider,
  type ExhaustedProvider,
  type ProviderDecision,
  type ProviderMetrics,
  type SelectionInput,
} from "./selection";

// TODO(model-router): заменить ThinkingLevelValue на настоящий тип ThinkingLevel из
// @earendil-works/pi-ai, когда пакет станет прямой зависимостью (сейчас
// резолвится только транзитивно через pi-coding-agent).
type ThinkingLevelValue =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const VIRTUAL_PROVIDER = "router";
const ROUTE_STALE_MS = 60_000;
const ROUTE_FETCH_TIMEOUT_MS = 3_000;
const BREAKER_FALLBACK_MS = 15 * 60_000;

interface RouterConfig {
  providerPriority: string[];
  tiers: Record<string, Record<string, string>>;
  forceBroken: Record<string, number>;
}

function notify(
  ctx: ExtensionContext,
  message: string,
  severity: "info" | "warning" | "error" = "error",
): void {
  try {
    ctx.ui.notify(message, severity);
  } catch {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseConfig(raw: unknown, source: string): RouterConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: expected object`);
  }
  const record = raw as Record<string, unknown>;
  if (
    !Array.isArray(record.providerPriority) ||
    record.providerPriority.some((id) => typeof id !== "string" || !id)
  ) {
    throw new Error(`${source}: providerPriority must be a non-empty string[]`);
  }
  if (!record.tiers || typeof record.tiers !== "object") {
    throw new Error(`${source}: tiers must be an object`);
  }
  const tiers: Record<string, Record<string, string>> = {};
  for (const [tier, tierRaw] of Object.entries(record.tiers)) {
    if (!tierRaw || typeof tierRaw !== "object" || Array.isArray(tierRaw)) {
      throw new Error(`${source}: tier '${tier}' must be an object`);
    }
    const candidates: Record<string, string> = {};
    for (const [provider, candidate] of Object.entries(tierRaw)) {
      if (typeof candidate !== "string" || !candidate) {
        throw new Error(
          `${source}: tiers.${tier}.${provider} must be a string "model[:thinking]"`,
        );
      }
      if (parseCandidateString(candidate) === undefined) {
        throw new Error(
          `${source}: tiers.${tier}.${provider}: invalid candidate '${candidate}'`,
        );
      }
      candidates[provider] = candidate;
    }
    if (Object.keys(candidates).length === 0) {
      throw new Error(`${source}: tier '${tier}' has no candidates`);
    }
    tiers[tier] = candidates;
  }
  const forceRaw = record.forceBroken ?? {};
  if (typeof forceRaw !== "object" || Array.isArray(forceRaw)) {
    throw new Error(`${source}: forceBroken must be an object`);
  }
  const forceBroken: Record<string, number> = {};
  for (const [provider, minutes] of Object.entries(forceRaw)) {
    if (
      typeof minutes !== "number" ||
      !Number.isFinite(minutes) ||
      minutes <= 0
    ) {
      throw new Error(
        `${source}: forceBroken.${provider} must be a positive number of minutes`,
      );
    }
    forceBroken[provider] = minutes;
  }
  return {
    providerPriority: record.providerPriority as string[],
    tiers,
    forceBroken,
  };
}

function candidateUnavailableReason(
  provider: string,
  candidate: string,
  models: { provider: string; id: string; thinkingLevelMap?: unknown }[],
  providerConfigured: (providerId: string) => boolean,
): string | undefined {
  const parsed = parseCandidateString(candidate);
  if (!parsed) return `${candidate}: неразбираемая строка кандидата`;
  const model = models.find(
    (entry) => entry.provider === provider && entry.id === parsed.model,
  );
  if (!model) {
    return providerConfigured(provider)
      ? `${provider}/${parsed.model}: нет в реестре`
      : `${provider}/${parsed.model}: провайдер не авторизован, роутить не получится`;
  }
  if (parsed.thinking) {
    const map = model.thinkingLevelMap as
      Record<string, string | null | undefined> | undefined;
    if (!map || map[parsed.thinking] == null) {
      return `${provider}/${parsed.model}: thinking '${parsed.thinking}' не поддерживается`;
    }
  }
  return undefined;
}

function providerMetrics(
  entry: QuotaCacheEntry | undefined,
): ProviderMetrics | undefined {
  if (!entry || entry.error) return undefined;
  return metricsFromWindows(entry.snapshot.windows);
}

function exhaustedText(exhausted: ExhaustedProvider[]): string {
  return exhausted.map((e) => `${e.provider}: ${e.reason}`).join(", ");
}

export default function (pi: ExtensionAPI) {
  let routerConfig: RouterConfig | undefined;
  try {
    const configPath = join(
      getAgentDir(),
      "extensions",
      "model-router",
      "config.json",
    );
    routerConfig = parseConfig(
      JSON.parse(readFileSync(configPath, "utf8")),
      configPath,
    );
  } catch (error) {
    console.error(`model-router: конфиг не читается: ${errorMessage(error)}`);
  }

  let refreshAbort: AbortController | undefined;
  let pendingRequestProvider: string | undefined;

  async function validateConfig(ctx: ExtensionContext): Promise<void> {
    if (!routerConfig) return;
    const models = ctx.modelRegistry.getAvailable();
    const providerConfigured = (providerId: string): boolean => {
      try {
        return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
      } catch {
        return false;
      }
    };
    const priority = new Set(routerConfig.providerPriority);
    const unavailable: string[] = [];
    for (const [tier, candidates] of Object.entries(routerConfig.tiers)) {
      for (const [provider, candidate] of Object.entries(candidates)) {
        if (!priority.has(provider)) {
          unavailable.push(
            `${tier}: ${provider} отсутствует в providerPriority, кандидат пропущен`,
          );
          continue;
        }
        const reason = candidateUnavailableReason(
          provider,
          candidate,
          models,
          providerConfigured,
        );
        if (reason) unavailable.push(`${tier}: ${reason}`);
      }
    }
    if (unavailable.length > 0) {
      notify(
        ctx,
        `model-router: кандидаты недоступны, роутинг на них не выполняется:\n${unavailable.join("\n")}`,
        "warning",
      );
    }
  }

  function selectionInput(
    ctx: ExtensionContext,
    tier: Record<string, string>,
  ): SelectionInput {
    const quotas: Record<string, ProviderMetrics | undefined> = {};
    const peakProviders = new Set<string>();
    const brokenProviders = new Set<string>();
    for (const provider of getActiveQuotaProviders(ctx)) {
      quotas[provider.id] = providerMetrics(getQuotaEntry(provider.id));
      if (provider.getPeakState?.(Date.now())?.active === true) {
        peakProviders.add(provider.id);
      }
      if (isProviderBroken(provider.id)) {
        brokenProviders.add(provider.id);
      }
    }
    return {
      providerPriority: routerConfig!.providerPriority,
      peakProviders,
      quotas,
      brokenProviders,
      tier,
    };
  }

  function toModelRoute(
    decision: ProviderDecision,
    request: ModelRouteRequest<unknown>,
    ctx: ExtensionContext,
  ): ModelRoute<unknown> {
    const model = ctx.modelRegistry.find(decision.provider, decision.model);
    if (!model) {
      throw new Error(
        `model-router: ${decision.modelString} пропала из реестра`,
      );
    }
    return {
      model,
      thinkingLevel: (decision.thinking ??
        request.thinkingLevel) as ThinkingLevelValue,
    };
  }

  function registerTier(
    tier: string,
    candidates: Record<string, string>,
  ): void {
    pi.registerVirtualModel({
      provider: VIRTUAL_PROVIDER,
      id: tier,
      name: `Router ${tier}`,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
      async route(request, ctx) {
        if (!routerConfig) {
          throw new Error("model-router: конфиг не загружен");
        }
        await refreshQuotas(ctx, request.signal ?? refreshAbort?.signal, {
          maxAgeMs: ROUTE_STALE_MS,
          timeoutMs: ROUTE_FETCH_TIMEOUT_MS,
          keepOnError: true,
        });
        const input = selectionInput(ctx, candidates);
        const sticky = request.failed ?? request.previous;
        if (
          sticky &&
          keepStickyProvider(
            request.reason,
            sticky.model.provider,
            input.brokenProviders,
          )
        ) {
          return {
            model: sticky.model,
            thinkingLevel: (sticky.thinkingLevel ??
              request.thinkingLevel) as ThinkingLevelValue,
          };
        }
        const result = selectProvider(input);
        if (result.ok) {
          const previous = request.previous?.model.provider;
          if (previous !== undefined && previous !== result.decision.provider) {
            notify(
              ctx,
              `model-router: switched ${previous} -> ${result.decision.provider} (${leaveReason(
                input.brokenProviders.has(previous),
                input.quotas[previous],
              )})`,
              "info",
            );
          }
          return toModelRoute(result.decision, request, ctx);
        }
        const blind = blindFallbackProvider(result.exhausted);
        if (blind !== undefined) {
          const candidate = parseCandidateString(candidates[blind]);
          const model = candidate
            ? ctx.modelRegistry.find(blind, candidate.model)
            : undefined;
          if (candidate && model) {
            return {
              model,
              thinkingLevel: (candidate.thinking ??
                request.thinkingLevel) as ThinkingLevelValue,
            };
          }
        }
        throw new Error(
          `model-router/${tier}: all providers exhausted (${exhaustedText(result.exhausted)})`,
        );
      },
    });
  }

  if (routerConfig) {
    for (const [tier, candidates] of Object.entries(routerConfig.tiers)) {
      registerTier(tier, candidates);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshAbort = new AbortController();
    if (!routerConfig) return;
    const forced = Object.entries(routerConfig.forceBroken);
    if (forced.length > 0) {
      for (const [provider, minutes] of forced) {
        markProviderBroken(provider, Date.now() + minutes * 60_000);
      }
      notify(
        ctx,
        `model-router: forceBroken активен (тест): ${forced.map(([provider]) => provider).join(", ")}`,
        "warning",
      );
    }
    await validateConfig(ctx);
    void refreshQuotas(ctx, refreshAbort.signal, {
      maxAgeMs: 0,
      timeoutMs: ROUTE_FETCH_TIMEOUT_MS,
      keepOnError: true,
    }).catch(() => {});
  });

  pi.on("before_provider_request", (_event, ctx) => {
    pendingRequestProvider = ctx.model?.provider;
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!routerConfig || event.status !== 429) return;
    const providerId = pendingRequestProvider ?? ctx.model?.provider;
    if (!providerId) return;
    pendingRequestProvider = undefined;
    const entry = getQuotaEntry(providerId);
    const resets = (entry?.snapshot.windows ?? [])
      .map((window) => window.resetAtMs)
      .filter(
        (reset): reset is number => reset !== undefined && reset > Date.now(),
      );
    markProviderBroken(
      providerId,
      resets.length > 0
        ? Math.min(...resets)
        : Date.now() + BREAKER_FALLBACK_MS,
    );
    void refreshQuotas(ctx, refreshAbort?.signal, {
      maxAgeMs: 0,
      keepOnError: true,
    }).catch(() => {});
  });

  pi.on("session_shutdown", () => {
    refreshAbort?.abort();
    refreshAbort = undefined;
  });
}
