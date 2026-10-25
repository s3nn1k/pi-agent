import { readFile, rename, writeFile } from "node:fs/promises";

export interface PingWindow {
  label: string;
  usedPercent: number;
  resetAtMs?: number;
}

export interface ColdStartWindowState {
  windowKey: number | string;
  pingedAtMs: number;
}

export type ColdStartState = Record<string, ColdStartWindowState>;

const HOUR_MS = 3_600_000;

export function needsPing(
  windows: readonly PingWindow[],
  nowMs: number,
): boolean {
  return !windows.some(
    (window) => window.resetAtMs !== undefined && window.resetAtMs > nowMs,
  );
}

export interface PingModelCandidate {
  cost: { input: number; output: number };
  thinkingLevelMap?: { off?: string | null };
}

export function pickModel<T extends PingModelCandidate>(
  models: readonly T[],
): T | undefined {
  return pickByCost(models.filter(hasPositiveCost)) ?? pickByCost(models);
}

function hasPositiveCost(model: PingModelCandidate): boolean {
  return model.cost.input + model.cost.output > 0;
}

function pickByCost<T extends PingModelCandidate>(
  models: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const model of models) {
    if (!best || isCheaper(model, best)) best = model;
  }
  return best;
}

function isCheaper(a: PingModelCandidate, b: PingModelCandidate): boolean {
  const costA = a.cost.input + a.cost.output;
  const costB = b.cost.input + b.cost.output;
  if (costA !== costB) return costA < costB;
  return hasThinkingOff(a) && !hasThinkingOff(b);
}

function hasThinkingOff(model: PingModelCandidate): boolean {
  return typeof model.thinkingLevelMap?.off === "string";
}

export function reportLine(providerId: string, status: string): string {
  return `cold-start: ${providerId}: ${status}`;
}

export function windowKey(
  windows: readonly PingWindow[],
  nowMs: number,
): number | string {
  const resetAtMs = windows.find(
    (window) => window.resetAtMs !== undefined,
  )?.resetAtMs;
  return resetAtMs ?? Math.floor(nowMs / HOUR_MS);
}

export function isWindowPinged(
  saved: ColdStartWindowState | undefined,
  windows: readonly PingWindow[],
  nowMs: number,
): boolean {
  if (!saved) return false;
  if (saved.windowKey === windowKey(windows, nowMs)) return true;
  return windows.some(
    (window) =>
      window.resetAtMs !== undefined && window.resetAtMs === saved.windowKey,
  );
}

export async function loadState(path: string): Promise<ColdStartState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  return parseState(raw);
}

export function parseState(raw: string): ColdStartState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const state: ColdStartState = {};
  for (const [providerId, value] of Object.entries(parsed)) {
    if (!isRecord(value)) continue;
    const { windowKey: key, pingedAtMs } = value;
    const keyValid = typeof key === "number" || typeof key === "string";
    if (keyValid && typeof pingedAtMs === "number") {
      state[providerId] = { windowKey: key, pingedAtMs };
    }
  }
  return state;
}

export async function saveState(
  path: string,
  state: ColdStartState,
): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
