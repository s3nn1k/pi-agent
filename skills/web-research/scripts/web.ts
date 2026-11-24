#!/usr/bin/env node
import {
  errMsg,
  num,
  out,
  parseArgs,
  renderDigest,
  renderResults,
  renderSnippets,
  truncate,
  type FetchResult,
  type Opts,
  type ResearchResult,
  type ResearchSource,
  type SearchResult,
} from "./lib/common.ts";
import * as zai from "./engines/zai.ts";

const USAGE = `
Usage:
  web search   <query>  [--max N] [--time day|week|month|year] [--lang xx] [--raw]
  web fetch    <url>    [--max-chars N]
  web research <query>  [--sources M] [--budget-chars N] [--no-browse]
  web zread    <owner/repo> doc <query> [--lang xx] | tree [dir_path] | file <file_path>  [--max-chars N]
  web health
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opts, positional } = parseArgs(rest);
  try {
    switch (cmd) {
      case "search":
        return out(await searchCmd(positional.join(" "), opts));
      case "fetch":
        return out(await fetchCmd(positional[0], opts));
      case "research":
        return out(await researchCmd(positional.join(" "), opts));
      case "zread":
        return out(await doZread(positional, opts));
      case "health":
        return out(await zai.zaiHealth());
      default:
        process.stderr.write(USAGE);
        process.exit(cmd ? 1 : 0);
    }
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: errMsg(err) })}\n`);
    process.exit(1);
  }
}

async function searchCmd(
  query: string,
  opts: Opts,
): Promise<string | SearchResult[]> {
  if (!query) throw new Error("query required");
  const results = await zai.searchResults(query, opts);
  return opts.raw ? results : renderResults(results);
}

async function fetchCmd(
  url: string | undefined,
  opts: Opts,
): Promise<FetchResult> {
  if (!url) throw new Error("url required");
  return zai.doFetch(url, opts);
}

async function researchCmd(query: string, opts: Opts): Promise<ResearchResult> {
  if (!query) throw new Error("query required");
  const sources = num(opts.sources, 3);
  const budget = num(opts["budget-chars"], 12000);
  const perSource = Math.floor(budget / sources);

  const results = await zai.searchResults(query, {
    lang: opts.lang,
    max: sources * 2,
  });
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

  const fetched: ResearchSource[] = [];
  for (const r of top) {
    try {
      const f = await zai.doFetch(r.url, { "max-chars": perSource });
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

const ZREAD_USAGE = `Usage:
  web zread <owner/repo> doc <query> [--lang xx]
  web zread <owner/repo> tree [dir_path]
  web zread <owner/repo> file <file_path>
  [--max-chars N]
`;

function zreadUsage(): never {
  process.stderr.write(ZREAD_USAGE);
  process.exit(1);
}

async function doZread(positional: string[], opts: Opts): Promise<string> {
  const [repo, action, ...rest] = positional;
  if (!repo || !/^[^\s/]+\/[^\s/]+$/.test(repo)) zreadUsage();
  const maxChars = num(opts["max-chars"], 20000);
  if (action === "doc") {
    const query = rest.join(" ").trim();
    if (!query) zreadUsage();
    return truncate(
      await zai.zreadDoc(
        repo,
        query,
        opts.lang ? String(opts.lang) : undefined,
      ),
      maxChars,
    );
  }
  if (action === "tree")
    return truncate(
      await zai.zreadTree(repo, rest.join(" ") || undefined),
      maxChars,
    );
  if (action === "file") {
    if (!rest[0]) zreadUsage();
    return truncate(await zai.zreadFile(repo, rest.join(" ")), maxChars);
  }
  zreadUsage();
}

main();
