import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  PeakState,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindow,
} from "../types";

const PROVIDER_ID = "zai";
const API_BASE = "https://api.z.ai/api/monitor/usage";

const TOKEN_WINDOWS: Record<number, { label: string }> = {
  3: { label: "5h" },
  6: { label: "wk" },
};

// TODO(migration): legacy V2 Max списывает квоту x3 в пик / x1 вне пика
// (docs.z.ai/devpack/notice/usage-revision, проверено 2026-08-31; legacy
// продлевается с сохранением правил — календарной даты переключения нет).
// После перехода на credits-план (офф-пик = 50% ставки → пик эффективен как
// x2) заменить на "x2".
const PEAK_RATE = "x3";
const PEAK_TZ_OFFSET_MS = 8 * 3_600_000;
const PEAK_START_MIN = 14 * 60;
const PEAK_END_MIN = 18 * 60;
const PEAK_WEEKDAYS = new Set([1, 2, 3, 4, 5]);

interface QuotaLimitEntry {
  type?: string;
  unit?: number;
  percentage?: number;
  nextResetTime?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
}

interface QuotaLimitResponse {
  data?: { level?: string; limits?: QuotaLimitEntry[] };
}

async function resolveApiKey(): Promise<string | undefined> {
  if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY;
  try {
    const auth = JSON.parse(
      await readFile(join(getAgentDir(), "auth.json"), "utf8"),
    ) as { zai?: { key?: string } };
    return auth.zai?.key;
  } catch {
    return undefined;
  }
}

function isActive(_ctx: ExtensionContext): boolean {
  if (process.env.ZAI_API_KEY) return true;
  try {
    const auth = JSON.parse(
      readFileSync(join(getAgentDir(), "auth.json"), "utf8"),
    ) as { zai?: { key?: string } };
    return typeof auth.zai?.key === "string" && auth.zai.key.length > 0;
  } catch {
    return false;
  }
}

async function apiGet<T>(
  path: string,
  key: string,
  signal: AbortSignal,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function peakBoundaryMs(localShifted: Date, minutesOfDay: number): number {
  return (
    Date.UTC(
      localShifted.getUTCFullYear(),
      localShifted.getUTCMonth(),
      localShifted.getUTCDate(),
      Math.floor(minutesOfDay / 60),
      minutesOfDay % 60,
    ) - PEAK_TZ_OFFSET_MS
  );
}

function peakState(now: number): PeakState {
  const local = new Date(now + PEAK_TZ_OFFSET_MS);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (
    PEAK_WEEKDAYS.has(local.getUTCDay()) &&
    minutes >= PEAK_START_MIN &&
    minutes < PEAK_END_MIN
  ) {
    return {
      active: true,
      rate: PEAK_RATE,
      endsInMs: peakBoundaryMs(local, PEAK_END_MIN) - now,
    };
  }
  return { active: false, rate: PEAK_RATE };
}

async function fetchQuota(
  signal: AbortSignal,
  _ctx: ExtensionContext,
): Promise<QuotaSnapshot> {
  const key = await resolveApiKey();
  if (!key) throw new Error("no key: set auth.json zai.key or ZAI_API_KEY");

  const payload = await apiGet<QuotaLimitResponse>("/quota/limit", key, signal);
  const data = payload?.data;
  if (!data || !Array.isArray(data.limits)) {
    throw new Error("unexpected /quota/limit schema");
  }

  const windows: QuotaWindow[] = [];
  for (const limit of data.limits) {
    const window = TOKEN_WINDOWS[limit?.unit ?? -1];
    if (
      limit?.type === "TOKENS_LIMIT" &&
      window &&
      typeof limit.percentage === "number"
    ) {
      windows.push({
        label: window.label,
        usedPercent: clampPercent(limit.percentage),
        resetAtMs:
          typeof limit.nextResetTime === "number"
            ? limit.nextResetTime
            : undefined,
      });
      continue;
    }
    if (
      limit?.type === "TIME_LIMIT" &&
      typeof limit.currentValue === "number"
    ) {
      const total =
        typeof limit.usage === "number"
          ? limit.usage
          : limit.currentValue + (limit.remaining ?? 0);
      if (total > 0) {
        windows.push({
          label: "mcp",
          usedPercent: clampPercent((limit.currentValue / total) * 100),
          resetAtMs:
            typeof limit.nextResetTime === "number"
              ? limit.nextResetTime
              : undefined,
        });
      }
    }
  }
  if (windows.length === 0) throw new Error("no token windows in /quota/limit");

  return {
    providerId: PROVIDER_ID,
    windows,
  };
}

export const zaiProvider: QuotaProvider = {
  id: PROVIDER_ID,
  isActive,
  fetchQuota,
  getPeakState: peakState,
};
