import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export type Opts = Record<string, string | boolean | number>;

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
};

export type FetchResult = {
  url: string;
  title: string;
  text: string;
  chars: number;
  browser: string;
  format: string;
  engine?: string;
  content?: string;
  selectorMatched?: number;
  challenge?: any;
  challengeResolved?: any;
  warning?: string;
  escalateReason?: string;
};

export type ResearchSource = {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  fetched?: {
    title?: string;
    text?: string;
    browser?: string;
    chars?: number;
    engine?: string;
    error?: string;
  };
};

export type ResearchResult =
  | { query: string; digest: string; sources: SearchResult[] }
  | {
      query: string;
      browsed: boolean;
      digest: string;
      sources: ResearchSource[];
    };

export async function loadDotEnv(file: string): Promise<void> {
  let txt;
  try {
    txt = await readFile(file, "utf-8");
  } catch {
    return;
  }
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || m[1].startsWith("#")) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export function parseArgs(argv: string[]): {
  opts: Opts;
  positional: string[];
} {
  const opts: Opts = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { opts, positional };
}

export const num = (v: string | boolean | number | undefined, def: number) => {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : def;
};

export const out = (o: unknown) =>
  process.stdout.write(
    typeof o === "string" ? o : `${JSON.stringify(o, null, 2)}\n`,
  );

export const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const truncate = (t: string, m: number) =>
  !t || t.length <= m ? t || "" : `${t.slice(0, m)}\n\n[…truncated]`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const renderSnippets = (q: string, rs: SearchResult[]): string =>
  `# ${q}\n\n(top search snippets — not browsed)\n\n` +
  rs
    .map((r, i) => `## ${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n");

export const renderResults = (rs: SearchResult[]): string =>
  rs
    .map((r, i) => `## ${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
    .join("\n\n");

const SOCIAL_HOST =
  /^(?:[a-z0-9-]+\.)*(?:instagram|facebook|tiktok|linkedin|twitter|x)\.com\.?$/i;
export const socialBlocked = (u: string): boolean => {
  try {
    return SOCIAL_HOST.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

export const renderDigest = (
  q: string,
  rs: ResearchSource[],
  perSource = 4000,
): string =>
  `# ${q}\n\n` +
  rs
    .map((r, i) => {
      const body = r.fetched?.text
        ? r.fetched.text.slice(0, perSource)
        : `(could not fetch: ${r.fetched?.error || "empty"})`;
      return `## ${i + 1}. ${r.fetched?.title || r.title}\nSource: ${r.url} (${r.fetched?.browser || "—"})\n\n${body}`;
    })
    .join("\n\n---\n\n");

export function runNode(
  args: string[],
  timeoutMs = 120000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached: true,
    });
    let out = "",
      err = "",
      settled = false,
      grace: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (p.pid !== undefined) process.kill(-p.pid, sig);
      } catch {
        try {
          p.kill(sig);
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      killGroup("SIGTERM");
      grace = setTimeout(() => killGroup("SIGKILL"), 3000);
      if (!settled) {
        settled = true;
        rej(new Error(`cloak-fetch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      fn();
    };
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (err += d));
    p.on("error", (e) => done(() => rej(e)));
    p.on("close", (code) =>
      done(() =>
        code === 0
          ? res({ stdout: out, stderr: err })
          : rej(new Error(`cloak-fetch exited ${code}: ${err.slice(0, 300)}`)),
      ),
    );
  });
}
