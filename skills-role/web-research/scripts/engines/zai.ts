import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  errMsg,
  num,
  socialBlocked,
  truncate,
  type FetchResult,
  type Opts,
  type SearchResult,
} from "../lib/common.ts";

const MCP_BASE = "https://api.z.ai/api/mcp";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const HTTP_TIMEOUT_MS = 30000;

let keyCache: string | undefined;

export function zaiKey(): string {
  if (keyCache === undefined) {
    let k = process.env.ZAI_API_KEY || "";
    if (!k) {
      try {
        k =
          JSON.parse(
            readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
          )?.zai?.key || "";
      } catch {}
    }
    keyCache = k;
  }
  return keyCache;
}

export const available = (): boolean => Boolean(zaiKey());

function requireKey(): string {
  const k = zaiKey();
  if (!k)
    throw new Error(
      "zai engine unavailable: set ZAI_API_KEY or zai.key in ~/.pi/agent/auth.json",
    );
  return k;
}

type RpcMsg = {
  id?: number | string;
  result?: any;
  error?: { message?: string; code?: number };
};

function parseRpcBody(body: string): RpcMsg[] {
  try {
    return [JSON.parse(body) as RpcMsg];
  } catch {}
  const msgs: RpcMsg[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      msgs.push(JSON.parse(payload) as RpcMsg);
    } catch {}
  }
  return msgs;
}

function authRefusal(payload: any): { code: number; msg: string } | null {
  const code = payload?.code;
  if (code !== 401 && code !== 403) return null;
  const msg = payload?.message ?? payload?.msg;
  return {
    code,
    msg: typeof msg === "string" && msg ? msg : `code ${code}`,
  };
}

async function mcpPost(
  server: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ sessionId: string | null; messages: RpcMsg[] }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireKey()}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const r = await fetch(`${MCP_BASE}/${server}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok)
    throw new Error(
      `zai mcp ${server} ${String(body.method)} → HTTP ${r.status}: ${text.slice(0, 200)}`,
    );
  return {
    sessionId: r.headers.get("mcp-session-id"),
    messages: parseRpcBody(text),
  };
}

const sessions = new Map<string, Promise<string>>();

async function handshake(server: string): Promise<string> {
  const init = await mcpPost(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "web-research", version: "1.0.0" },
    },
  });
  const sid = init.sessionId;
  if (!sid) {
    const refused = init.messages.map(authRefusal).find(Boolean);
    if (refused)
      throw new Error(`zai mcp ${server}: auth refused (${refused.msg})`);
    throw new Error(`zai mcp ${server}: initialize без mcp-session-id`);
  }
  const msg = init.messages.find((m) => m.id === 1);
  if (msg?.error)
    throw new Error(
      `zai mcp ${server} initialize: ${msg.error.message || msg.error.code}`,
    );
  await mcpPost(
    server,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sid,
  );
  return sid;
}

function session(server: string): Promise<string> {
  let s = sessions.get(server);
  if (!s) {
    s = handshake(server).catch((e) => {
      sessions.delete(server);
      throw e;
    });
    sessions.set(server, s);
  }
  return s;
}

async function callTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<any> {
  const r = await mcpPost(
    server,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: args },
    },
    await session(server),
  );
  const msg = r.messages.find((m) => m.id === 2) || r.messages[0];
  if (msg?.error)
    throw new Error(
      `zai mcp ${server}/${tool}: ${msg.error.message || msg.error.code}`,
    );
  if (!msg?.result)
    throw new Error(`zai mcp ${server}/${tool}: empty response`);
  if (msg.result.isError === true)
    throw new Error(`zai mcp ${server}/${tool}: ${textOf(msg.result)}`);
  return msg.result;
}

function textOf(result: any): string {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string")
    throw new Error("zai mcp: no content[0].text in response");
  return text;
}

function decodeDouble(result: any): any {
  return JSON.parse(JSON.parse(textOf(result)));
}

function decodeText(result: any): string {
  const text = JSON.parse(textOf(result));
  if (typeof text !== "string")
    throw new Error(
      `zai mcp zread: unexpected payload ${JSON.stringify(text).slice(0, 200)}`,
    );
  if (/^code: \d+, message:/i.test(text))
    throw new Error(`zai mcp zread: ${text}`);
  return text;
}

const RECENCY: Record<string, string> = {
  day: "oneDay",
  week: "oneWeek",
  month: "oneMonth",
  year: "oneYear",
};

export async function searchResults(
  query: string,
  opts: Opts,
): Promise<SearchResult[]> {
  const args: Record<string, unknown> = {
    search_query: query.slice(0, 70),
  };
  if (query.length > 70)
    process.stderr.write(
      `${JSON.stringify({ note: "zai query truncated to 70 chars" })}\n`,
    );
  const recency = RECENCY[String(opts.time || "")];
  if (recency) args.search_recency_filter = recency;
  const raw = decodeDouble(
    await callTool("web_search_prime", "web_search_prime", args),
  );
  if (!Array.isArray(raw))
    throw new Error(
      `zai mcp web_search_prime: unexpected payload ${JSON.stringify(raw).slice(0, 200)}`,
    );
  return raw
    .map((x: any): SearchResult => ({
      title: x?.title ?? "",
      url: x?.link ?? "",
      snippet: (x?.content ?? "").trim(),
      engine: "zai",
    }))
    .filter((r) => r.url && !socialBlocked(r.url))
    .slice(0, num(opts.max, 10));
}

export async function doFetch(url: string, opts: Opts): Promise<FetchResult> {
  const page = decodeDouble(await callTool("web_reader", "webReader", { url }));
  const content = typeof page?.content === "string" ? page.content : "";
  return {
    url: page?.url || url,
    title: page?.title || "",
    text: truncate(content, num(opts["max-chars"], 20000)),
    chars: content.length,
    browser: "zai",
    format: "markdown",
    engine: "zai",
  };
}

export function zreadDoc(
  repo: string,
  query: string,
  lang?: string,
): Promise<string> {
  const args: Record<string, unknown> = { repo_name: repo, query };
  if (lang) args.language = lang;
  return zreadText("search_doc", args);
}

export function zreadTree(repo: string, dirPath?: string): Promise<string> {
  const args: Record<string, unknown> = { repo_name: repo };
  if (dirPath) args.dir_path = dirPath;
  return zreadText("get_repo_structure", args);
}

export function zreadFile(repo: string, filePath: string): Promise<string> {
  return zreadText("read_file", { repo_name: repo, file_path: filePath });
}

async function zreadText(
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  return decodeText(await callTool("zread", tool, args));
}

export async function zaiHealth(): Promise<{ zai: string; mcp: string }> {
  const key = zaiKey();
  if (!key) return { zai: "no key", mcp: "unknown" };
  try {
    const r = await fetch(QUOTA_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const refused = authRefusal(j);
    if (refused) throw new Error(`HTTP ${refused.code}: ${refused.msg}`);
    if (j?.success === false)
      throw new Error(String(j?.msg || "unsuccessful response"));
    const limits = j?.data?.limits;
    const time = (Array.isArray(limits) ? limits : []).find(
      (l: any) => l?.type === "TIME_LIMIT",
    );
    if (!time) throw new Error("no TIME_LIMIT entry");
    return { zai: "ok", mcp: `${time.currentValue}/${time.usage}` };
  } catch (e) {
    const reason = errMsg(e);
    if (/^HTTP 40[13]\b/.test(reason))
      return { zai: "bad key", mcp: "unknown" };
    return { zai: `quota-api: ${reason}`, mcp: "unknown" };
  }
}
