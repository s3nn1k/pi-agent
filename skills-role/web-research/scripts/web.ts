#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  errMsg,
  loadDotEnv,
  num,
  out,
  parseArgs,
  renderResults,
  sleep,
  truncate,
  type FetchResult,
  type Opts,
  type ResearchResult,
  type SearchResult,
  SCRIPTS_DIR,
} from "./lib/common.ts";
import type { ResearchDeps } from "./engines/local.ts";

await loadDotEnv(join(SCRIPTS_DIR, ".env"));
const local = await import("./engines/local.ts");
const zai = await import("./engines/zai.ts");

const USAGE = `
Usage:
  web init                idempotent bootstrap: .env + docker + Chromium
  web search   <query>  [--max N] [--lang xx] [--time day|week|month|year] [--engines a,b] [--raw]
                        [--engine zai|local]
  web fetch    <url>    [--format readability|text|html|snapshot] [--selector CSS] [--schema JSON]
                        [--browser auto|camofox|cloak] [--max-chars N] [--scroll] [--wait ms] [--proxy URL]
                        [--engine zai|local]
  web research <query>  [--sources M] [--budget-chars N] [--no-browse] [--lang xx] [--engine zai|local]
  web zread    <owner/repo> doc <query> [--lang xx] | tree [dir_path] | file <file_path>  [--max-chars N]
  web health
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opts, positional } = parseArgs(rest);
  try {
    switch (cmd) {
      case "init":
        return await doInit();
      case "search":
        return out(await searchCmd(positional.join(" "), opts));
      case "fetch":
        return out(await fetchCmd(positional[0], opts));
      case "research":
        return out(await researchCmd(positional.join(" "), opts));
      case "zread":
        return out(await doZread(positional, opts));
      case "health":
        return out(await healthAll());
      default:
        process.stderr.write(USAGE);
        process.exit(cmd ? 1 : 0);
    }
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: errMsg(err) })}\n`);
    process.exit(1);
  }
}

const ENV_FILE = join(SCRIPTS_DIR, ".env");
const log = (msg: string) => process.stdout.write(`\n==> ${msg}\n`);

type EngineMode = "auto" | "zai" | "local";

function engineMode(opts: Opts): EngineMode {
  const v = String(opts.engine ?? "auto");
  if (v === "auto" || v === "zai" || v === "local") return v;
  throw new Error(`--engine must be zai|local (got "${v}")`);
}

const escalate = (to: string, reason: string) =>
  process.stderr.write(`${JSON.stringify({ escalate: to, reason })}\n`);

async function searchCmd(
  query: string,
  opts: Opts,
): Promise<string | SearchResult[]> {
  if (!query) throw new Error("query required");
  const results = await searchVia(query, opts);
  return opts.raw ? results : renderResults(results);
}

async function searchVia(query: string, opts: Opts): Promise<SearchResult[]> {
  const mode = engineMode(opts);
  if (mode === "zai") {
    if (opts.engines)
      process.stderr.write(
        `${JSON.stringify({ warning: "--engines is a searxng option; ignored with --engine zai" })}\n`,
      );
    return zai.searchResults(query, opts);
  }
  if (mode === "local") return local.searchResults(query, opts);
  if (!opts.engines && zai.available()) {
    try {
      return await zai.searchResults(query, opts);
    } catch (e) {
      escalate("searxng", errMsg(e));
    }
  }
  return local.searchResults(query, opts);
}

async function fetchCmd(
  url: string | undefined,
  opts: Opts,
): Promise<FetchResult> {
  if (!url) throw new Error("url required");
  return fetchVia(url, opts);
}

function webReaderCompatible(opts: Opts): boolean {
  const format =
    opts.format === undefined ? "readability" : String(opts.format);
  return (
    !opts.selector && !opts.schema && !opts.browser && format === "readability"
  );
}

async function fetchVia(url: string, opts: Opts): Promise<FetchResult> {
  const mode = engineMode(opts);
  if (mode === "local") return local.doFetch(url, opts);
  if (!webReaderCompatible(opts)) {
    if (mode === "zai")
      throw new Error(
        "--engine zai supports plain readability fetch only: --selector/--schema/--format/--browser are local-stack contracts (webReader returns markdown)",
      );
    return local.doFetch(url, opts);
  }
  if (mode === "zai") return zai.doFetch(url, opts);
  if (zai.available()) {
    try {
      const r = await zai.doFetch(url, opts);
      if (r.chars > 0) return r;
      escalate("local", "zai webReader: empty content");
    } catch (e) {
      escalate("local", errMsg(e));
    }
  }
  return local.doFetch(url, opts);
}

async function researchCmd(query: string, opts: Opts): Promise<ResearchResult> {
  if (!query) throw new Error("query required");
  const mode = engineMode(opts);
  const deps: ResearchDeps =
    mode === "local"
      ? {}
      : {
          search: (q, o) => searchVia(q, { ...o, engine: opts.engine }),
          fetch: (u, o) => fetchVia(u, { ...o, engine: opts.engine }),
        };
  return local.doResearch(query, opts, deps);
}

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

async function healthAll() {
  const [l, z] = await Promise.all([local.doHealth(), zai.zaiHealth()]);
  return { ...l, ...z };
}

const have = (bin: string) =>
  spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const versionLine = (bin: string): string | null => {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.error) return null;
  return `${r.stdout}${r.stderr}`.split("\n")[0].trim();
};
const dockerAlive = () =>
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const imageReady = (image: string) =>
  spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" })
    .status === 0;
const httpCode = async (u: string): Promise<string> => {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(5000) });
    return r.ok ? String(r.status) : "000";
  } catch {
    return "000";
  }
};

async function doInit(): Promise<void> {
  log("Prereqs...");
  for (const bin of ["docker", "node", "npm"]) {
    const v = versionLine(bin);
    if (v === null) {
      process.stdout.write(`  ✗ ${bin} not found in PATH\n`);
      process.stdout.write(
        bin === "docker"
          ? "    install Docker Desktop or colima, then re-run.\n"
          : "    install via brew (or your package manager), then re-run.\n",
      );
      process.exit(1);
    }
    process.stdout.write(`  ok: ${bin} (${v})\n`);
  }
  const [nodeMajor, nodeMinor] = process.versions.node
    .split(".")
    .map((n) => parseInt(n, 10));
  if (nodeMajor < 23 || (nodeMajor === 23 && nodeMinor < 6)) {
    process.stdout.write(
      `  ✗ node >=23.6 required (have ${process.versions.node}); web.ts runs on built-in TS type stripping.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("  ok: node >=23.6\n");

  if (!dockerAlive()) {
    process.stdout.write("  docker daemon не запущен — пробую стартовать...\n");
    if (
      process.platform === "darwin" &&
      existsSync("/Applications/Docker.app")
    ) {
      spawnSync("open", ["-a", "Docker"]);
    } else if (have("systemctl")) {
      const first = spawnSync("sudo", ["systemctl", "start", "docker"], {
        stdio: ["inherit", "inherit", "ignore"],
      });
      if (first.status !== 0)
        spawnSync("sudo", ["systemctl", "start", "docker.service"], {
          stdio: ["inherit", "inherit", "ignore"],
        });
    } else if (have("colima")) {
      spawnSync("colima", ["start"], {
        stdio: ["ignore", "inherit", "ignore"],
      });
    }
    for (let i = 0; i < 30 && !dockerAlive(); i++) await sleep(2000);
    if (!dockerAlive()) {
      process.stdout.write(
        "  ✗ daemon так и не поднялся — стартуй Docker Desktop / colima вручную и re-run.\n",
      );
      process.exit(1);
    }
    process.stdout.write("  ok: docker daemon (auto-started)\n");
  } else {
    process.stdout.write("  ok: docker daemon\n");
  }

  const hlth = await healthAll();
  if (hlth.searxng === "ok" && hlth.camofox === "ok") {
    log("Stack already up and healthy — nothing to do.");
    out(hlth);
    return;
  }

  initEnvFile();
  await loadDotEnv(ENV_FILE);

  log("CloakBrowser (npm install)...");
  const installed = spawnSync("npm", ["ls", "cloakbrowser"], {
    cwd: SCRIPTS_DIR,
    stdio: "ignore",
  });
  if (installed.status === 0) {
    process.stdout.write("  up to date: cloakbrowser\n");
  } else {
    const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: SCRIPTS_DIR,
      stdio: "inherit",
    });
    if (install.status !== 0) process.exit(install.status ?? 1);
    process.stdout.write("  installed: cloakbrowser + playwright-core\n");
  }
  const cbDir = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".cloakbrowser",
  );
  let leftovers: string[] = [];
  try {
    leftovers = readdirSync(cbDir).filter(
      (n) => n.startsWith("_download_") && n.endsWith(".tar.gz"),
    );
  } catch {}
  if (leftovers.length) {
    for (const f of leftovers) unlinkSync(join(cbDir, f));
    process.stdout.write("  cleaned: leftover Chromium partial downloads\n");
  }

  log("CloakBrowser Chromium binary (~140 MB)...");
  let chromium: string | undefined;
  try {
    chromium = readdirSync(cbDir).find((n) => n.startsWith("chromium-"));
  } catch {}
  if (chromium) {
    process.stdout.write(`  exists: ${join(cbDir, chromium)}\n`);
  } else {
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS_DIR, "node_modules/cloakbrowser/dist/cli.js"), "install"],
      { cwd: SCRIPTS_DIR, stdio: "inherit" },
    );
    process.stdout.write(
      r.status === 0
        ? "  downloaded\n"
        : "  WARN: Chromium download failed — cloak докачает при первом fetch (нужна сеть до cloakbrowser.dev)\n",
    );
  }

  log("Pull images (с retry)...");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pull = spawnSync(
      "docker",
      ["compose", "--env-file", ENV_FILE, "pull"],
      { cwd: SCRIPTS_DIR, encoding: "utf8" },
    );
    const noise =
      /Pulling fs layer|Downloading|Extracting|Pull complete|Already exists|^ [0-9]/;
    for (const line of `${pull.stdout}${pull.stderr}`.split("\n"))
      if (line && !noise.test(line)) process.stdout.write(`${line}\n`);
    if (
      imageReady("searxng/searxng:latest") &&
      imageReady("ghcr.io/jo-inc/camofox-browser:latest")
    ) {
      process.stdout.write("  images ready\n");
      break;
    }
    process.stdout.write(`  retry pull (${attempt}/3)...\n`);
    await sleep(3000);
    if (attempt === 3) {
      process.stdout.write(
        "  ✕ pull не удался за 3 попытки — проверь сеть до ghcr.io / docker hub\n",
      );
      process.exit(1);
    }
  }

  log("Docker compose up (SearXNG + Camofox)...");
  const up = spawnSync(
    "docker",
    ["compose", "--env-file", ENV_FILE, "up", "-d"],
    { cwd: SCRIPTS_DIR, stdio: "inherit" },
  );
  if (up.status !== 0) process.exit(up.status ?? 1);
  process.stdout.write("  started\n");

  log("Waiting for services to settle...");
  for (let i = 1; i <= 30; i++) {
    const sx = await httpCode(
      "http://localhost:9388/search?format=json&q=health",
    );
    const cf = await httpCode("http://localhost:9377/health");
    if (sx === "200" && cf === "200") break;
    process.stdout.write(`  searxng=${sx} camofox=${cf} ... (${i}/30)\n`);
    await sleep(2000);
  }

  process.stdout.write("\n");
  process.stdout.write(
    "──────────────────────────────────────────────────────────────────\n",
  );
  process.stdout.write("  web-research status:\n");
  out(await healthAll());
  process.stdout.write("\n");
  process.stdout.write(
    "  CAMOFOX_API_KEY — в scripts/.env; web.ts подгружает его сам.\n",
  );
  process.stdout.write(
    "──────────────────────────────────────────────────────────────────\n",
  );
}

function initEnvFile(): void {
  log("Camofox .env + SearXNG secret...");
  if (!existsSync(ENV_FILE)) {
    const gen = () => randomBytes(24).toString("hex");
    writeFileSync(
      ENV_FILE,
      [
        "# generated by web.ts init — do not commit",
        `CAMOFOX_API_KEY=${gen()}`,
        `CAMOFOX_ADMIN_KEY=${gen()}`,
        `SEARXNG_SECRET=${gen()}`,
      ].join("\n") + "\n",
    );
    chmodSync(ENV_FILE, 0o600);
    process.stdout.write(
      `  generated: ${ENV_FILE} (keep it secret; web.ts грузит его сам)\n`,
    );
    return;
  }
  process.stdout.write(`  exists: ${ENV_FILE}\n`);
  if (!/^SEARXNG_SECRET=/m.test(readFileSync(ENV_FILE, "utf8"))) {
    appendFileSync(
      ENV_FILE,
      `SEARXNG_SECRET=${randomBytes(24).toString("hex")}\n`,
    );
    process.stdout.write("  patched: added SEARXNG_SECRET\n");
  }
}

main();
