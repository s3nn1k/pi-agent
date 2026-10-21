import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
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
  leaveReason,
  metricsFromWindows,
  parseCandidateString,
  selectProvider,
  type ExhaustedProvider,
  type LeaveReason,
  type ProviderDecision,
  type ProviderMetrics,
} from "./selection";

// TODO(model-router): заменить ThinkingLevelValue на настоящий тип ThinkingLevel из
// @earendil-works/pi-ai, когда пакет станет прямой зависимостью (сейчас
// резолвится только транзитивно через pi-coding-agent).
type ThinkingLevelValue =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PREFRESH_STALE_MS = 60_000;
const PREFRESH_TIMEOUT_MS = 3_000;
const REFRESH_DEBOUNCE_MS = 3_000;
const BREAKER_FALLBACK_MS = 15 * 60_000;

interface RouterConfig {
  providerPriority: string[];
  tiers: Record<string, Record<string, string>>;
}

interface AppliedTierRouting {
  decision: ProviderDecision;
  metrics: ProviderMetrics | undefined;
  broken: boolean;
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
  return {
    providerPriority: record.providerPriority as string[],
    tiers,
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

function frontmatterSlice(source: string): string[] | undefined {
  const lines = source.split("\n");
  if (lines[0] !== "---") return undefined;
  const closeIndex = lines.indexOf("---", 1);
  if (closeIndex === -1) return undefined;
  return lines.slice(1, closeIndex);
}

function extractModelTier(source: string): string | undefined {
  for (const line of frontmatterSlice(source) ?? []) {
    const match = /^modelTier:\s*(\S+)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function rewriteFrontmatterModel(
  source: string,
  modelValue: string,
): string | undefined {
  const lines = source.split("\n");
  if (lines[0] !== "---") return undefined;
  const closeIndex = lines.indexOf("---", 1);
  if (closeIndex === -1) return undefined;
  let tierLineIndex = -1;
  let modelLineIndex = -1;
  for (let index = 1; index < closeIndex; index++) {
    if (modelLineIndex === -1 && /^model:/.test(lines[index])) {
      modelLineIndex = index;
    }
    if (tierLineIndex === -1 && /^modelTier:/.test(lines[index])) {
      tierLineIndex = index;
    }
  }
  if (tierLineIndex === -1) return undefined;
  const modelLine = `model: ${modelValue}`;
  if (modelLineIndex !== -1) {
    if (lines[modelLineIndex] === modelLine) return undefined;
    lines[modelLineIndex] = modelLine;
  } else {
    lines.splice(tierLineIndex + 1, 0, modelLine);
  }
  return lines.join("\n");
}

async function collectAgentFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectAgentFiles(path)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !entry.name.endsWith(".chain.md")
    ) {
      files.push(path);
    }
  }
  return files;
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now().toString(36)}.model-router.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let routerConfig: RouterConfig | undefined;
  let lastApplied: Map<string, AppliedTierRouting> | undefined;
  let refreshAbort: AbortController | undefined;
  let refreshDebounce: NodeJS.Timeout | undefined;
  let applyChain: Promise<void> = Promise.resolve();
  let sessionGeneration = 0;
  let pendingRequestProvider: string | undefined;

  async function loadConfig(
    ctx: ExtensionContext,
  ): Promise<RouterConfig | undefined> {
    const configPath = join(
      getAgentDir(),
      "extensions",
      "model-router",
      "config.json",
    );
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      notify(ctx, `model-router: конфиг не читается: ${errorMessage(error)}`);
      return undefined;
    }
    let config: RouterConfig;
    try {
      config = parseConfig(JSON.parse(raw), configPath);
    } catch (error) {
      notify(ctx, `model-router: ${errorMessage(error)}`);
      return undefined;
    }

    const models = ctx.modelRegistry.getAvailable();
    const providerConfigured = (providerId: string): boolean => {
      try {
        return ctx.modelRegistry.getProviderAuthStatus(providerId).configured;
      } catch {
        return false;
      }
    };
    const priority = new Set(config.providerPriority);
    const unavailable: string[] = [];
    const tiers: Record<string, Record<string, string>> = {};
    for (const [tier, candidates] of Object.entries(config.tiers)) {
      const valid: Record<string, string> = {};
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
        if (reason) {
          unavailable.push(`${tier}: ${reason}`);
          continue;
        }
        valid[provider] = candidate;
      }
      if (Object.keys(valid).length === 0) {
        unavailable.push(
          `${tier}: не осталось доступных кандидатов, тир выключен`,
        );
        continue;
      }
      tiers[tier] = valid;
    }

    if (unavailable.length > 0) {
      notify(
        ctx,
        `model-router: кандидаты недоступны, роутинг на них не выполняется:\n${unavailable.join("\n")}`,
        "warning",
      );
    }
    if (Object.keys(tiers).length === 0) {
      notify(
        ctx,
        "model-router: нет доступных моделей ни для одного тира — роутинг отключён; агенты идут на subagents.defaultModel",
        "error",
      );
      return undefined;
    }
    return { providerPriority: config.providerPriority, tiers };
  }

  function buildDecisions(ctx: ExtensionContext): {
    decisions: Map<string, ProviderDecision>;
    exhausted: Map<string, ExhaustedProvider[]>;
  } {
    const quotas: Record<string, ProviderMetrics | undefined> = {};
    const peakProviders = new Set<string>();
    for (const provider of getActiveQuotaProviders(ctx)) {
      quotas[provider.id] = providerMetrics(getQuotaEntry(provider.id));
      if (provider.getPeakState?.(Date.now())?.active === true) {
        peakProviders.add(provider.id);
      }
    }
    const brokenProviders = new Set(
      getActiveQuotaProviders(ctx)
        .map((provider) => provider.id)
        .filter((id) => isProviderBroken(id)),
    );

    const decisions = new Map<string, ProviderDecision>();
    const exhausted = new Map<string, ExhaustedProvider[]>();
    for (const [tier, candidates] of Object.entries(
      routerConfig?.tiers ?? {},
    )) {
      const result = selectProvider({
        providerPriority: routerConfig?.providerPriority ?? [],
        peakProviders,
        quotas,
        brokenProviders,
        tier: candidates,
      });
      if (result.ok) decisions.set(tier, result.decision);
      else exhausted.set(tier, result.exhausted);
    }
    return { decisions, exhausted };
  }

  function appliedRouting(decision: ProviderDecision): AppliedTierRouting {
    return {
      decision,
      metrics: providerMetrics(getQuotaEntry(decision.provider)),
      broken: isProviderBroken(decision.provider),
    };
  }

  function recordSwitch(
    applied: Map<string, AppliedTierRouting>,
    tier: string,
    decision: ProviderDecision,
    switches: Map<string, { from: string; to: string; reason: LeaveReason }>,
  ): void {
    const previous = applied.get(tier);
    if (!previous || previous.decision.provider === decision.provider) return;
    const reason = leaveReason(previous.broken, previous.metrics);
    switches.set(
      `${previous.decision.provider}|${decision.provider}|${reason}`,
      {
        from: previous.decision.provider,
        to: decision.provider,
        reason,
      },
    );
  }

  async function applyMainSession(
    ctx: ExtensionContext,
    decision: ProviderDecision,
  ): Promise<boolean> {
    const current = ctx.model;
    const sameModel =
      current !== undefined &&
      current.provider === decision.provider &&
      current.id === decision.model;
    const sameThinking =
      decision.thinking === undefined ||
      pi.getThinkingLevel() === (decision.thinking as ThinkingLevelValue);
    if (sameModel && sameThinking) return true;

    const model = ctx.modelRegistry.find(decision.provider, decision.model);
    if (!model) {
      notify(
        ctx,
        `model-router: ${decision.modelString} пропала из реестра, мейн-сессия не переключена`,
      );
      return false;
    }
    const applied = await pi.setModel(model);
    if (!applied) {
      notify(
        ctx,
        `model-router: не удалось переключить мейн-сессию на ${decision.modelString}`,
      );
      return false;
    }
    if (decision.thinking !== undefined) {
      pi.setThinkingLevel(decision.thinking as ThinkingLevelValue);
    }
    return true;
  }

  async function rewriteAgents(
    ctx: ExtensionContext,
    decisions: Map<string, ProviderDecision>,
    applied: Map<string, AppliedTierRouting>,
    switches: Map<string, { from: string; to: string; reason: LeaveReason }>,
  ): Promise<void> {
    const agentsDir = join(getAgentDir(), "agents");
    let files: string[];
    try {
      files = await collectAgentFiles(agentsDir);
    } catch (error) {
      notify(ctx, `model-router: ${agentsDir}: ${errorMessage(error)}`);
      return;
    }
    for (const file of files) {
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch (error) {
        notify(ctx, `model-router: ${file}: ${errorMessage(error)}`);
        continue;
      }
      const tier = extractModelTier(source);
      if (tier === undefined) continue;
      const decision = decisions.get(tier) ?? applied.get(tier)?.decision;
      if (!decision) continue;
      const updated = rewriteFrontmatterModel(source, decision.modelString);
      if (updated === undefined) {
        if (decisions.has(tier)) {
          recordSwitch(applied, tier, decision, switches);
        }
        continue;
      }
      try {
        await writeAtomically(file, updated);
        if (decisions.has(tier)) {
          recordSwitch(applied, tier, decision, switches);
        }
      } catch (error) {
        notify(ctx, `model-router: ${file}: ${errorMessage(error)}`);
      }
    }
  }

  async function applyRouting(ctx: ExtensionContext): Promise<void> {
    if (!routerConfig) return;
    const { decisions, exhausted } = buildDecisions(ctx);

    const applied = new Map<string, AppliedTierRouting>(lastApplied ?? []);
    const switches = new Map<
      string,
      { from: string; to: string; reason: LeaveReason }
    >();

    const frontier = decisions.get("frontier");
    if (frontier) {
      if (await applyMainSession(ctx, frontier)) {
        recordSwitch(applied, "frontier", frontier, switches);
      }
    } else {
      const frontierExhausted = exhausted.get("frontier");
      if (frontierExhausted) {
        notify(
          ctx,
          `model-router: all providers exhausted (${exhaustedText(frontierExhausted)}); keeping last routing`,
        );
      }
    }

    await rewriteAgents(ctx, decisions, applied, switches);

    if (switches.size > 0) {
      const lines = [...switches.values()].map(
        ({ from, to, reason }) =>
          `model-router: switched ${from} -> ${to} (${from} ${reason})`,
      );
      notify(ctx, lines.join("\n"), "info");
    }

    if (decisions.size > 0) {
      const merged = new Map(lastApplied ?? []);
      for (const [tier, decision] of decisions) {
        merged.set(tier, appliedRouting(decision));
      }
      lastApplied = merged;
    }
  }

  function scheduleApply(ctx: ExtensionContext, generation: number): void {
    applyChain = applyChain
      .then(() => {
        if (generation !== sessionGeneration) return;
        return applyRouting(ctx);
      })
      .catch((error) => notify(ctx, `model-router: ${errorMessage(error)}`));
  }

  async function refresh(
    ctx: ExtensionContext,
    options?: Parameters<typeof refreshQuotas>[2],
  ): Promise<void> {
    await refreshQuotas(ctx, refreshAbort?.signal, options);
  }

  pi.on("session_start", async (_event, ctx) => {
    refreshAbort = new AbortController();
    lastApplied = undefined;
    routerConfig = await loadConfig(ctx);
    if (!routerConfig) return;
    const generation = sessionGeneration;
    await refresh(ctx).catch((error) =>
      notify(ctx, `model-router: ${errorMessage(error)}`),
    );
    scheduleApply(ctx, generation);
    await applyChain;
  });

  pi.on("turn_start", (_event, ctx) => {
    if (!routerConfig) return;
    const generation = sessionGeneration;
    const activeProvider =
      lastApplied?.get("frontier")?.decision.provider ??
      ctx.model?.provider ??
      routerConfig.providerPriority[0];
    const entry = getQuotaEntry(activeProvider);
    if (
      entry &&
      Date.now() - entry.fetchedAtMs < PREFRESH_STALE_MS &&
      !entry.error
    ) {
      scheduleApply(ctx, generation);
      return;
    }
    void refresh(ctx, {
      maxAgeMs: 0,
      timeoutMs: PREFRESH_TIMEOUT_MS,
      keepOnError: true,
    })
      .then(() => scheduleApply(ctx, generation))
      .catch((error) => notify(ctx, `model-router: ${errorMessage(error)}`));
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
    void refresh(ctx, { maxAgeMs: 0, keepOnError: true })
      .then(() => scheduleApply(ctx, sessionGeneration))
      .catch((error) => notify(ctx, `model-router: ${errorMessage(error)}`));
  });

  pi.on("message_end", (_event, ctx) => {
    if (!routerConfig || refreshDebounce) return;
    const stale = getActiveQuotaProviders(ctx).some((provider) => {
      const entry = getQuotaEntry(provider.id);
      return !entry || Date.now() - entry.fetchedAtMs >= PREFRESH_STALE_MS;
    });
    if (!stale) return;
    refreshDebounce = setTimeout(() => {
      refreshDebounce = undefined;
      void refresh(ctx, { maxAgeMs: PREFRESH_STALE_MS })
        .then(() => scheduleApply(ctx, sessionGeneration))
        .catch((error) => notify(ctx, `model-router: ${errorMessage(error)}`));
    }, REFRESH_DEBOUNCE_MS);
    refreshDebounce.unref();
  });

  pi.on("session_shutdown", () => {
    sessionGeneration++;
    refreshAbort?.abort();
    refreshAbort = undefined;
    if (refreshDebounce) {
      clearTimeout(refreshDebounce);
      refreshDebounce = undefined;
    }
  });
}
