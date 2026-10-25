import type { QuotaProvider } from "../types";
import { openaiCodexProvider } from "./openai-codex.ts";
import { zaiProvider } from "./zai.ts";

export const quotaProviders: QuotaProvider[] = [
  zaiProvider,
  openaiCodexProvider,
];
