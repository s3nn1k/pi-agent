import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { quotaProviders } from "./providers/registry.ts";
import type { QuotaProvider, QuotaSnapshot } from "./types";

const SNAPSHOT_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const ACTIVE_RECHECK_MS = 60_000;
export const ERROR_RETRY_MS = 30_000;

export interface QuotaCacheEntry {
  snapshot: QuotaSnapshot;
  fetchedAtMs: number;
  error?: string;
}

export interface RefreshOptions {
  maxAgeMs?: number;
  timeoutMs?: number;
  keepOnError?: boolean;
}

const cache = new Map<string, QuotaCacheEntry>();
const inFlight = new Map<string, Promise<void>>();

export const BREAKER_MIN_TTL_MS = 90_000;
export const BREAKER_MAX_TTL_MS = 15 * 60_000;

interface ProviderBreaker {
  markAtMs: number;
  untilMs: number;
}

const breakers = new Map<string, ProviderBreaker>();

export function markProviderBroken(
  providerId: string,
  untilMs: number,
  nowMs: number = Date.now(),
): void {
  const effective = Math.min(
    Math.max(untilMs, nowMs + BREAKER_MIN_TTL_MS),
    nowMs + BREAKER_MAX_TTL_MS,
  );
  const existing = breakers.get(providerId);
  if (existing && effective <= existing.untilMs) return;
  breakers.set(providerId, {
    markAtMs: existing?.markAtMs ?? nowMs,
    untilMs: effective,
  });
}

export function clearProviderBreaker(providerId: string): void {
  breakers.delete(providerId);
}

export function isProviderBroken(
  providerId: string,
  nowMs: number = Date.now(),
): boolean {
  const breaker = breakers.get(providerId);
  if (!breaker) return false;
  if (breaker.untilMs <= nowMs) {
    breakers.delete(providerId);
    return false;
  }
  return true;
}

function breakerClearableOnFetch(providerId: string): boolean {
  const breaker = breakers.get(providerId);
  if (!breaker) return true;
  return Date.now() - breaker.markAtMs >= BREAKER_MIN_TTL_MS;
}

function snapshotMetricsHealthy(snapshot: QuotaSnapshot): boolean {
  const windows = new Map(
    snapshot.windows.map((w) => [w.label, w.usedPercent]),
  );
  const wk = windows.get("wk");
  const fh = windows.get("5h");
  return wk !== 100 && fh !== 100;
}

let activeCache: QuotaProvider[] = [];
let activeCheckedAt = 0;

export function getActiveQuotaProviders(
  ctx: ExtensionContext,
): QuotaProvider[] {
  if (Date.now() - activeCheckedAt > ACTIVE_RECHECK_MS) {
    activeCheckedAt = Date.now();
    activeCache = quotaProviders.filter((provider) => provider.isActive(ctx));
  }
  return activeCache;
}

export function getQuotaEntry(providerId: string): QuotaCacheEntry | undefined {
  return cache.get(providerId);
}

function isFetchDue(
  entry: QuotaCacheEntry | undefined,
  maxAgeMs: number,
): boolean {
  if (!entry) return true;
  const age = Date.now() - entry.fetchedAtMs;
  return age >= (entry.error ? Math.min(maxAgeMs, ERROR_RETRY_MS) : maxAgeMs);
}

function fetchSignal(
  sessionSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return sessionSignal ? AbortSignal.any([sessionSignal, timeout]) : timeout;
}

async function loadProviderSnapshot(
  provider: QuotaProvider,
  ctx: ExtensionContext,
  sessionSignal: AbortSignal | undefined,
  options: RefreshOptions,
): Promise<void> {
  try {
    const snapshot = await provider.fetchQuota(
      fetchSignal(sessionSignal, options.timeoutMs ?? FETCH_TIMEOUT_MS),
      ctx,
    );
    cache.set(provider.id, { snapshot, fetchedAtMs: Date.now() });
    if (
      breakerClearableOnFetch(provider.id) &&
      snapshotMetricsHealthy(snapshot)
    ) {
      clearProviderBreaker(provider.id);
    }
  } catch (error) {
    if (sessionSignal?.aborted) return;
    if (options.keepOnError) return;
    const message = error instanceof Error ? error.message : String(error);
    const previous = cache.get(provider.id);
    if (previous) {
      previous.error = message;
      previous.fetchedAtMs = Date.now();
    } else {
      cache.set(provider.id, {
        snapshot: { providerId: provider.id, windows: [] },
        fetchedAtMs: Date.now(),
        error: message,
      });
    }
  }
}

function refreshProvider(
  provider: QuotaProvider,
  ctx: ExtensionContext,
  sessionSignal: AbortSignal | undefined,
  options: RefreshOptions,
): Promise<void> {
  const inProgress = inFlight.get(provider.id);
  if (inProgress) return inProgress;
  const pending = loadProviderSnapshot(
    provider,
    ctx,
    sessionSignal,
    options,
  ).finally(() => {
    if (inFlight.get(provider.id) === pending) inFlight.delete(provider.id);
  });
  inFlight.set(provider.id, pending);
  return pending;
}

export async function refreshQuotas(
  ctx: ExtensionContext,
  sessionSignal?: AbortSignal,
  options: RefreshOptions = {},
): Promise<void> {
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_TTL_MS;
  const targets = getActiveQuotaProviders(ctx).filter((provider) =>
    isFetchDue(cache.get(provider.id), maxAgeMs),
  );
  await Promise.all(
    targets.map((provider) =>
      refreshProvider(provider, ctx, sessionSignal, options),
    ),
  );
}
