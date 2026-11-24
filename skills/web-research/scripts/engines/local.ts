import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectChallenge } from "../cloak/challenges.mjs";
import { validateUrlWithDns } from "../cloak/lib/url-validation.mjs";
import {
  errMsg,
  num,
  renderDigest,
  renderSnippets,
  runNode,
  SCRIPTS_DIR,
  sleep,
  socialBlocked,
  truncate,
  type FetchResult,
  type Opts,
  type ResearchResult,
  type ResearchSource,
  type SearchResult,
} from "../lib/common.ts";

const SEARXNG = process.env.SEARXNG_URL || "http://localhost:9388";
const CAMOFOX = process.env.CAMOFOX_URL || "http://localhost:9377";
const CAMO_KEY = process.env.CAMOFOX_API_KEY || "";
const USER_ID = process.env.CAMOFOX_USER_ID || "web-bot";
const SESSION = "default";

const ENGINE_POOL = (
  process.env.SEARXNG_POOL
    ? process.env.SEARXNG_POOL.split(",")
    : [
        "bing",
        "duckduckgo",
        "brave",
        "mojeek",
        "qwant",
        "startpage",
        "yahoo",
        "yandex",
        "dogpile",
        "infospace",
        "privacywall",
        "presearch",
        "yep",
        "crowdview",
        "mwmbl",
        "ayo",
        "resulthunter",
        "searchtoday",
        "tusksearch",
        "vuhuv",
        "gabanza",
        "reloado",
        "fynd",
      ]
)
  .map((s) => s.trim())
  .filter(Boolean);
const ENGINE_SUBSET = Math.max(
  1,
  parseInt(process.env.SEARXNG_SUBSET || "", 10) || 3,
);
const ENGINE_STABLE = process.env.SEARXNG_ENGINES || "bing,qwant,mojeek";

function pickEngines(pool: string[], n: number): string[] {
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

async function searxng(
  query: string,
  opts: Opts = {},
): Promise<SearchResult[]> {
  const build = (engines: string) => {
    const u = new URL(`${SEARXNG}/search`);
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    if (opts.lang) u.searchParams.set("language", String(opts.lang));
    if (opts.time) u.searchParams.set("time_range", String(opts.time));
    if (engines) u.searchParams.set("engines", engines);
    return u;
  };
  const ask = async (u: URL): Promise<any[]> => {
    const r = await fetch(u, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok)
      throw new Error(
        `SearXNG ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
      );
    return (await r.json()).results || [];
  };

  const engines = String(
    opts.engines ||
      pickEngines(ENGINE_POOL, ENGINE_SUBSET).join(",") ||
      ENGINE_STABLE,
  );
  let results = await ask(build(engines));
  if (!opts.engines && results.length === 0) {
    results = await ask(build(ENGINE_STABLE));
  }

  return results
    .map((x): SearchResult => ({
      title: x.title,
      url: x.url,
      snippet: (x.content || "").trim(),
      engine: x.engine,
    }))
    .filter((x) => !socialBlocked(x.url))
    .slice(0, num(opts.max, 10));
}

export async function searchResults(
  query: string,
  opts: Opts,
): Promise<SearchResult[]> {
  if (!query) throw new Error("query required");
  return searxng(query, opts);
}

type Fetcher = (url: string, opts: Opts) => Promise<FetchResult>;

export async function doFetch(
  url: string | undefined,
  opts: Opts = {},
): Promise<FetchResult> {
  if (!url) throw new Error("url required");
  const urlCheck = await validateUrlWithDns(url);
  if (!urlCheck.valid) throw new Error(`URL blocked: ${urlCheck.reason}`);
  const browser = String(opts.browser || "auto");
  const format = String(opts.format || "readability");
  const FULL_PAGE = ["readability", "text", "html"].includes(format);
  const call = (fn: Fetcher) => fn(url, { ...opts, format });
  if (browser === "camofox") return call(camofoxFetch);
  if (browser === "cloak") return call(cloakFetch);
  try {
    const res = await call(camofoxFetch);
    if (FULL_PAGE && looksBlocked(res)) {
      process.stderr.write(
        `${JSON.stringify({ escalate: "cloak", reason: res.escalateReason })}\n`,
      );
      try {
        return await call(cloakFetch);
      } catch (e) {
        process.stderr.write(
          `${JSON.stringify({ cloak_failed: errMsg(e), fallback: "camofox as-is" })}\n`,
        );
        res.warning = `cloak unavailable: ${errMsg(e)}`;
        return res;
      }
    }
    return res;
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ escalate: "cloak", reason: errMsg(err) })}\n`,
    );
    try {
      return await call(cloakFetch);
    } catch (e) {
      throw new Error(`camofox: ${errMsg(err)} | cloak: ${errMsg(e)}`);
    }
  }
}

function looksBlocked(res: FetchResult): boolean {
  if (res.challenge) {
    res.escalateReason = res.challenge.strategy;
    return true;
  }
  const t = (res.text || res.content || "").toLowerCase();
  if (
    /just a moment|checking your browser|enable javascript and cookies|cf-challenge|attention required|access denied/i.test(
      t,
    )
  ) {
    res.escalateReason = "challenge-text";
    return true;
  }
  const origLen = typeof res.chars === "number" ? res.chars : t.length;
  if (!t || origLen < 200) {
    res.escalateReason = "empty-content";
    return true;
  }
  return false;
}

async function camofoxFetch(url: string, opts: Opts): Promise<FetchResult> {
  const format = String(opts.format || "readability");
  const maxChars = num(opts["max-chars"], 20000);
  const tabId = await camofox("tabs", {
    method: "POST",
    body: { userId: USER_ID, sessionKey: SESSION, url },
  });
  if (!tabId?.tabId)
    throw new Error(
      `Camofox create-tab failed: ${JSON.stringify(tabId).slice(0, 200)}`,
    );
  const id = tabId.tabId;
  try {
    if (opts.scroll)
      await camofox(`tabs/${id}/scroll`, {
        method: "POST",
        body: { userId: USER_ID, direction: "down" },
      });
    await sleep(num(opts.wait, 800));

    let text: string, title: string, selectorMatched: number | undefined;
    if (format === "snapshot") {
      const snap = await camofox(`tabs/${id}/snapshot?userId=${USER_ID}`);
      text =
        typeof snap === "string"
          ? snap
          : snap?.snapshot || JSON.stringify(snap);
      title = snap?.title;
    } else if (format === "html") {
      const r = await camofox(`tabs/${id}/evaluate`, {
        auth: true,
        body: {
          userId: USER_ID,
          expression: "document.documentElement.outerHTML",
        },
      });
      text = r?.result;
      title = "";
    } else if (opts.selector) {
      const expr = `(()=>{const els=Array.from(document.querySelectorAll(${JSON.stringify(opts.selector)}));return JSON.stringify({count:els.length,text:els.map(e=>e.innerText||'').join('\\n\\n')})})()`;
      const r = await camofox(`tabs/${id}/evaluate`, {
        auth: true,
        body: { userId: USER_ID, expression: expr },
      });
      let parsed;
      try {
        parsed = JSON.parse(r?.result || "null");
      } catch {}
      text = parsed?.text ?? "";
      title = "";
      selectorMatched = parsed?.count ?? 0;
    } else if (opts.schema) {
      const r = await camofox(`tabs/${id}/extract`, {
        body: { userId: USER_ID, schema: JSON.parse(String(opts.schema)) },
      });
      text = JSON.stringify(r, null, 2);
      title = "";
    } else {
      const rb = await camofoxReadability(id);
      text = rb?.text || "";
      title = rb?.title || "";
      if (!text) {
        const r = await camofox(`tabs/${id}/evaluate`, {
          auth: true,
          body: {
            userId: USER_ID,
            expression: 'document.body?.innerText || ""',
          },
        });
        text = r?.result || "";
      }
    }
    const reportedFormat = opts.selector
      ? "selector"
      : opts.schema
        ? "schema"
        : format;
    const FULL_PAGE = !opts.selector && !opts.schema && format !== "snapshot";
    let challenge = null;
    if (FULL_PAGE)
      challenge = await detectCamofoxChallenge(id, url).catch(() => null);
    const out: FetchResult = {
      url,
      title,
      text: truncate(text, maxChars),
      chars: text.length,
      browser: "camofox",
      format: reportedFormat,
      engine: "camofox",
    };
    if (opts.selector) out.selectorMatched = selectorMatched ?? 0;
    if (challenge) out.challenge = challenge;
    return out;
  } finally {
    await camofox(`tabs/${id}?userId=${USER_ID}`, { method: "DELETE" }).catch(
      () => {},
    );
  }
}

async function camofox(
  path: string,
  {
    method,
    body,
    auth = false,
  }: {
    method?: string;
    body?: Record<string, unknown>;
    auth?: boolean;
  } = {},
): Promise<any> {
  method = method || (body ? "POST" : "GET");
  const headers: Record<string, string> = body
    ? { "Content-Type": "application/json" }
    : {};
  if (auth && CAMO_KEY) headers.Authorization = `Bearer ${CAMO_KEY}`;
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(60000),
  };
  if (body) init.body = JSON.stringify(body);
  const r = await fetch(`${CAMOFOX}/${path}`, init);
  const txt = await r.text();
  if (!r.ok)
    throw new Error(
      `Camofox ${method} ${path} → ${r.status}: ${txt.slice(0, 200)}`,
    );
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}

async function camofoxReadability(tabId: string): Promise<any> {
  const rbJs = await readFile(
    join(SCRIPTS_DIR, "camofox/Readability.js"),
    "utf-8",
  );
  const expr =
    rbJs +
    "; var a=new Readability(document.cloneNode(true)).parse(); JSON.stringify({title:a&&a.title,text:a&&a.textContent,length:a&&a.length})";
  const r = await camofox(`tabs/${tabId}/evaluate`, {
    auth: true,
    body: { userId: USER_ID, expression: expr },
  });
  try {
    return JSON.parse(r?.result || "null");
  } catch {
    return null;
  }
}

const CHALLENGE_PROBE = `(() => {
  const unique = a => [...new Set(a.filter(Boolean))];
  const resourceUrls = unique([
    ...Array.from(document.scripts, s => s.src),
    ...Array.from(document.querySelectorAll('iframe[src]'), e => e.getAttribute('src')),
    ...Array.from(document.querySelectorAll('form[action]'), e => e.getAttribute('action')),
    ...Array.from(document.querySelectorAll('link[href]'), e => e.getAttribute('href')),
    ...Array.from(document.querySelectorAll('object[data]'), e => e.getAttribute('data')),
    ...Array.from(document.querySelectorAll('embed[src]'), e => e.getAttribute('src')),
  ]).slice(0, 500);
  const markers = [];
  for (const el of document.querySelectorAll('[id],[class],[name],[data-sitekey],[data-action]')) {
    if (markers.length >= 500) break;
    for (const attr of el.attributes) {
      if (markers.length >= 500) break;
      if (['id','class','name'].includes(attr.name) || attr.name.startsWith('data-')) markers.push(attr.name + '=' + attr.value);
    }
  }
  const cookieNames = document.cookie ? document.cookie.split(';').map(c => c.split('=')[0] && c.split('=')[0].trim()).filter(Boolean) : [];
  return JSON.stringify({ resourceUrls, markers: markers.slice(0, 1000), cookieNames });
})()`;

async function detectCamofoxChallenge(
  tabId: string,
  url: string,
): Promise<any> {
  const r = await camofox(`tabs/${tabId}/evaluate`, {
    auth: true,
    body: { userId: USER_ID, expression: CHALLENGE_PROBE },
  });
  let data;
  try {
    data = JSON.parse(r?.result || "null");
  } catch {
    return null;
  }
  if (!data) return null;
  return detectChallenge({
    url,
    responseUrl: url,
    responseHeaders: {},
    resourceUrls: data.resourceUrls || [],
    markers: data.markers || [],
    cookieNames: data.cookieNames || [],
  });
}

async function cloakFetch(url: string, opts: Opts): Promise<FetchResult> {
  if (opts.selector) return cloakSelectorFetch(url, opts);
  const format = opts.format === "html" ? "html" : "text";
  const maxChars = num(opts["max-chars"], 20000);
  const args = [
    join(SCRIPTS_DIR, "cloak/cloak-fetch.mjs"),
    url,
    "--format",
    format,
    "--max-chars",
    String(maxChars),
  ];
  if (opts.scroll) args.push("--scroll");
  if (opts.wait != null) args.push("--wait", String(opts.wait));
  if (opts.proxy) args.push("--proxy", String(opts.proxy));
  const { stdout, stderr } = await runNode(args);
  if (stderr) process.stderr.write(stderr);
  const r = JSON.parse(stdout.trim().split("\n").pop()!);
  for (const k of ["url", "title", "content", "chars"]) {
    if (r[k] === undefined)
      throw new Error(
        `cloak-fetch contract drift: missing "${k}" (got ${JSON.stringify(Object.keys(r)).slice(0, 200)})`,
      );
  }
  return {
    url: r.url,
    title: r.title,
    text: r.content,
    chars: r.chars,
    browser: "cloak",
    format,
    engine: "cloak",
    challenge: r.challenge,
    challengeResolved: r.challengeResolved,
  };
}

async function cloakSelectorFetch(
  url: string,
  opts: Opts,
): Promise<FetchResult> {
  const maxChars = num(opts["max-chars"], 20000);
  const args = [
    join(SCRIPTS_DIR, "cloak/cloak-script.mjs"),
    "--script",
    join(SCRIPTS_DIR, "cloak/scripts/selector-eval.mjs"),
  ];
  if (opts.proxy) args.push("--proxy", String(opts.proxy));
  const env = {
    ...process.env,
    WR_URL: url,
    WR_SELECTOR: String(opts.selector),
  };
  const { stdout, stderr } = await runNode(args, 90000, env);
  if (stderr) process.stderr.write(stderr);
  const r = JSON.parse(stdout.trim().split("\n").pop()!);
  if (r.error) throw new Error(`cloak selector: ${r.error}`);
  if (!r.data)
    throw new Error(
      `cloak-script contract drift: missing "data" (got ${JSON.stringify(Object.keys(r)).slice(0, 200)})`,
    );
  const data = r.data;
  const text = data.text || "";
  return {
    url: data.url || url,
    title: data.title || "",
    text: truncate(text, maxChars),
    chars: text.length,
    browser: "cloak",
    format: "selector",
    engine: "cloak",
    selectorMatched: data.matched ?? 0,
  };
}

export type ResearchDeps = {
  search?: (query: string, opts: Opts) => Promise<SearchResult[]>;
  fetch?: (url: string, opts: Opts) => Promise<FetchResult>;
};

export async function doResearch(
  query: string,
  opts: Opts = {},
  deps: ResearchDeps = {},
): Promise<ResearchResult> {
  if (!query) throw new Error("query required");
  const sources = num(opts.sources, 3);
  const budget = num(opts["budget-chars"], 12000);
  const perSource = Math.floor(budget / sources);

  const results = await (deps.search
    ? deps.search(query, { lang: opts.lang, max: sources * 2 })
    : searxng(query, { lang: opts.lang, max: sources * 2 }));
  if (!results.length) return { query, digest: "No results.", sources: [] };

  const top = results.slice(0, sources);
  const snippets = top.map((r) => r.snippet).filter(Boolean);
  if (
    opts["no-browse"] ||
    (snippets.join(" ").length > 600 && looksSelfSufficient(query, snippets))
  ) {
    return {
      query,
      browsed: false,
      digest: renderSnippets(query, top),
      sources: top.map(meta),
    };
  }

  const fetchOne = deps.fetch ?? doFetch;
  const fetched: ResearchSource[] = [];
  for (const r of top) {
    try {
      const f = await fetchOne(r.url, {
        format: "readability",
        "max-chars": perSource,
        browser: "auto",
      });
      fetched.push({
        ...meta(r),
        fetched: {
          title: f.title,
          text: f.text,
          browser: f.browser,
          chars: f.chars,
          engine: f.engine,
        },
      });
    } catch (err) {
      fetched.push({ ...meta(r), fetched: { error: errMsg(err) } });
    }
  }
  return {
    query,
    browsed: true,
    digest: renderDigest(query, fetched, perSource),
    sources: fetched,
  };
}

function looksSelfSufficient(query: string, snippets: string[]): boolean {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 3);
  if (!terms.length) return false;
  const blob = snippets.join(" ").toLowerCase();
  return terms.every((t) => blob.includes(t));
}
const meta = (r: SearchResult) => ({
  title: r.title,
  url: r.url,
  snippet: r.snippet,
  engine: r.engine,
});

export async function doHealth() {
  return {
    searxng: await ping(`${SEARXNG}/search?format=json&q=health`),
    camofox: await ping(`${CAMOFOX}/health`),
    camofox_auth: Boolean(process.env.CAMOFOX_API_KEY),
    cloak: cloakReady(),
  };
}
async function ping(u: string): Promise<string> {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(3000) });
    return r.ok ? "ok" : `http-${r.status}`;
  } catch (e) {
    return `down: ${errMsg(e)}`;
  }
}
function cloakReady(): string {
  if (!existsSync(join(SCRIPTS_DIR, "node_modules", "cloakbrowser")))
    return "not installed (npm install in scripts/)";
  const cbDir = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".cloakbrowser",
  );
  let hasChromium = false;
  try {
    hasChromium = readdirSync(cbDir).some((n) => n.startsWith("chromium-"));
  } catch {}
  return hasChromium
    ? "ok"
    : "no-chromium-binary (run: node node_modules/cloakbrowser/dist/cli.js install)";
}
