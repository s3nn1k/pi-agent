import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaProvider, QuotaSnapshot, QuotaWindow } from "../types";

const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

interface WhamWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
}

interface WhamUsageResponse {
  rate_limit?: {
    primary_window?: WhamWindow;
    secondary_window?: WhamWindow;
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function durationLabel(seconds: number): string {
  if (seconds === 604_800) return "wk";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function resetAtMs(window: WhamWindow, nowMs: number): number | undefined {
  if (typeof window.reset_at === "number" && window.reset_at > 0) {
    return window.reset_at >= 10_000_000_000
      ? Math.round(window.reset_at)
      : Math.round(window.reset_at * 1_000);
  }
  if (
    typeof window.reset_after_seconds === "number" &&
    window.reset_after_seconds >= 0
  ) {
    return nowMs + Math.round(window.reset_after_seconds * 1_000);
  }
  return undefined;
}

function toQuotaWindow(
  window: WhamWindow | undefined,
  fallbackLabel: string,
  nowMs: number,
): QuotaWindow | undefined {
  if (!window || typeof window.used_percent !== "number") return undefined;
  const label =
    typeof window.limit_window_seconds === "number" &&
    window.limit_window_seconds > 0
      ? durationLabel(window.limit_window_seconds)
      : fallbackLabel;
  return {
    label,
    usedPercent: clampPercent(window.used_percent),
    resetAtMs: resetAtMs(window, nowMs),
  };
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object") return undefined;
    const claims = decoded as Record<string, unknown>;
    const auth = claims[JWT_AUTH_CLAIM];
    if (!auth || typeof auth !== "object") return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function isActive(ctx: ExtensionContext): boolean {
  return ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
}

async function fetchQuota(
  signal: AbortSignal,
  ctx: ExtensionContext,
): Promise<QuotaSnapshot> {
  const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (!token) throw new Error("no OpenAI Codex credential: run /login");

  const accountId = accountIdFromToken(token);
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    },
    signal,
  });
  if (!response.ok) throw new Error(`/wham/usage -> HTTP ${response.status}`);

  const payload = (await response.json()) as WhamUsageResponse;
  const nowMs = Date.now();
  const rateLimit = payload.rate_limit;
  const windows = [
    toQuotaWindow(rateLimit?.primary_window, "primary", nowMs),
    toQuotaWindow(rateLimit?.secondary_window, "secondary", nowMs),
  ].filter((window): window is QuotaWindow => window !== undefined);
  if (windows.length === 0) {
    throw new Error("unexpected /wham/usage schema");
  }

  return { providerId: PROVIDER_ID, windows };
}

export const openaiCodexProvider: QuotaProvider = {
  id: PROVIDER_ID,
  isActive,
  fetchQuota,
};
