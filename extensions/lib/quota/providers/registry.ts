import type { QuotaProvider } from "../types";
import { openaiCodexProvider } from "./openai-codex";
import { zaiProvider } from "./zai";

export const quotaProviders: QuotaProvider[] = [
  zaiProvider,
  openaiCodexProvider,
];
