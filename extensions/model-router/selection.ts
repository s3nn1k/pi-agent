export interface QuotaWindowLike {
  label: string;
  usedPercent: number;
}

export interface ProviderMetrics {
  wk?: number;
  fh?: number;
}

export interface TierCandidate {
  model: string;
  thinking?: string;
}

export interface SelectionInput {
  providerPriority: string[];
  peakProviders: ReadonlySet<string>;
  quotas: Readonly<Record<string, ProviderMetrics | undefined>>;
  brokenProviders: ReadonlySet<string>;
  tier: Readonly<Record<string, string>>;
  threshold: number;
}

export interface ProviderDecision {
  provider: string;
  model: string;
  thinking?: string;
  modelString: string;
  pass: 1 | 2 | 3 | 4;
  wk: number;
  fh: number;
}

export type ExhaustionReason = "429" | "wk=100" | "5h=100" | "no data";

export interface ExhaustedProvider {
  provider: string;
  reason: ExhaustionReason;
}

export type SelectionResult =
  | { ok: true; decision: ProviderDecision }
  | { ok: false; exhausted: ExhaustedProvider[] };

export type LeaveReason =
  | "hit 429"
  | "hit wk limit"
  | "hit 5h limit"
  | "hit wk threshold"
  | "hit 5h threshold"
  | "no quota data"
  | "priority";

export type RouteReason = "user" | "continuation" | "retry" | "direct";

export function keepStickyProvider(
  reason: RouteReason,
  stickyProvider: string | undefined,
  brokenProviders: ReadonlySet<string>,
  metrics?: ProviderMetrics,
): boolean {
  return (
    reason !== "user" &&
    stickyProvider !== undefined &&
    !brokenProviders.has(stickyProvider) &&
    metrics?.wk !== 100 &&
    metrics?.fh !== 100
  );
}

export function blindFallbackProvider(
  exhausted: readonly ExhaustedProvider[],
): string | undefined {
  return exhausted.find((entry) => entry.reason === "no data")?.provider;
}

export function parseCandidateString(raw: string): TierCandidate | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const colon = raw.lastIndexOf(":");
  if (colon === -1) return { model: raw };
  const model = raw.slice(0, colon);
  const thinking = raw.slice(colon + 1);
  if (model.length === 0 || thinking.length === 0) return undefined;
  return { model, thinking };
}

export function demotePeakProviders(
  priority: readonly string[],
  peak: ReadonlySet<string>,
): string[] {
  const active: string[] = [];
  const demoted: string[] = [];
  for (const provider of priority) {
    (peak.has(provider) ? demoted : active).push(provider);
  }
  return [...active, ...demoted];
}

export function metricsFromWindows(
  windows: readonly QuotaWindowLike[],
): ProviderMetrics {
  const metrics: ProviderMetrics = {};
  for (const window of windows) {
    if (window.label === "wk") metrics.wk = window.usedPercent;
    else if (window.label === "5h") metrics.fh = window.usedPercent;
  }
  return metrics;
}

function windowPasses(
  pass: 1 | 2 | 3 | 4,
  wk: number | undefined,
  fh: number | undefined,
  threshold: number,
): boolean {
  if (wk === undefined || fh === undefined) return false;
  if (fh === 100) return false;
  if (pass === 4) return wk !== 100;
  if (fh >= threshold) return false;
  if (pass === 1) return wk < 60;
  if (pass === 2) return wk < 80;
  return wk < threshold;
}

function exhaustionReason(
  broken: boolean,
  metrics: ProviderMetrics | undefined,
): ExhaustionReason {
  if (broken) return "429";
  if (metrics?.wk === 100) return "wk=100";
  if (!broken && metrics?.fh === 100) return "5h=100";
  return "no data";
}

export function selectProvider(input: SelectionInput): SelectionResult {
  const order = demotePeakProviders(
    input.providerPriority,
    input.peakProviders,
  );
  const exhausted: ExhaustedProvider[] = [];

  for (const pass of [1, 2, 3, 4] as const) {
    for (const provider of order) {
      const candidateString = input.tier[provider];
      if (candidateString === undefined) continue;
      const broken = input.brokenProviders.has(provider);
      if (broken) {
        if (pass === 1 && !exhausted.some((e) => e.provider === provider)) {
          exhausted.push({
            provider,
            reason: exhaustionReason(true, input.quotas[provider]),
          });
        }
        continue;
      }
      const metrics = input.quotas[provider];
      if (!windowPasses(pass, metrics?.wk, metrics?.fh, input.threshold)) {
        if (pass === 1 && !exhausted.some((e) => e.provider === provider)) {
          exhausted.push({
            provider,
            reason: exhaustionReason(false, metrics),
          });
        }
        continue;
      }
      const candidate = parseCandidateString(candidateString);
      if (!candidate) continue;
      return {
        ok: true,
        decision: {
          provider,
          model: candidate.model,
          ...(candidate.thinking !== undefined
            ? { thinking: candidate.thinking }
            : {}),
          modelString: `${provider}/${candidateString}`,
          pass,
          wk: metrics?.wk as number,
          fh: metrics?.fh as number,
        },
      };
    }
  }

  exhausted.sort(
    (a, b) => order.indexOf(a.provider) - order.indexOf(b.provider),
  );
  return { ok: false, exhausted };
}

export function leaveReason(
  broken: boolean,
  metrics: ProviderMetrics | undefined,
  threshold: number,
): LeaveReason {
  if (broken) return "hit 429";
  if (metrics?.wk === 100) return "hit wk limit";
  if (metrics?.fh === 100) return "hit 5h limit";
  if (metrics?.wk !== undefined && metrics.wk >= threshold) {
    return "hit wk threshold";
  }
  if (metrics?.fh !== undefined && metrics.fh >= threshold) {
    return "hit 5h threshold";
  }
  if (metrics?.wk === undefined || metrics?.fh === undefined) {
    return "no quota data";
  }
  return "priority";
}
