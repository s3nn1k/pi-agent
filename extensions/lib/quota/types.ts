import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetAtMs?: number;
}

export interface QuotaSnapshot {
  providerId: string;
  windows: QuotaWindow[];
}

export interface PeakState {
  active: boolean;
  rate?: string;
  endsInMs?: number;
}

export interface QuotaProvider {
  id: string;
  isActive(ctx: ExtensionContext): boolean;
  fetchQuota(
    signal: AbortSignal,
    ctx: ExtensionContext,
  ): Promise<QuotaSnapshot>;
  getPeakState?(nowMs: number): PeakState;
}
