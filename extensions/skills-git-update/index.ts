import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  aggregateInvalidPaths,
  classifyRepo,
  isAlreadyUpToDate,
  parseConfig,
  partitionResolutions,
  selectSkillPaths,
  statResolution,
  summarizeReports,
  type GitUpdateConfig,
  type PathResolution,
  type RepoEvent,
  type RepoReport,
  type Severity,
} from "./logic.ts";

const execFile = promisify(execFileCallback);

const MAX_BUFFER_BYTES = 1024 * 1024;

function notify(
  ctx: ExtensionContext,
  message: string,
  severity: Severity = "error",
): void {
  try {
    if (!ctx.hasUI) return;
    ctx.ui.notify(message, severity);
  } catch {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitErrorDetail(error: unknown): string {
  const err = error as { stderr?: string; stdout?: string; message?: string };
  const detail = [err.stderr, err.stdout, err.message]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return detail ?? "unknown git error";
}

async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mergeUpstream(
  toplevel: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    return isAlreadyUpToDate(
      await runGit(["merge", "--ff-only", "@{u}"], toplevel, timeoutMs),
    );
  } catch (error) {
    if (!/index\.lock/i.test(gitErrorDetail(error))) throw error;
    await sleep(2_000);
    return isAlreadyUpToDate(
      await runGit(["merge", "--ff-only", "@{u}"], toplevel, timeoutMs),
    );
  }
}

async function loadConfig(ctx: ExtensionContext): Promise<GitUpdateConfig> {
  const configPath = join(
    getAgentDir(),
    "extensions",
    "skills-git-update",
    "config.json",
  );
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    notify(
      ctx,
      `skills-git-update: конфиг не читается, работаю по дефолтам: ${errorMessage(error)}`,
      "error",
    );
    return parseConfig(undefined);
  }
  try {
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    notify(
      ctx,
      `skills-git-update: битый конфиг, работаю по дефолтам: ${errorMessage(error)}`,
      "error",
    );
    return parseConfig(undefined);
  }
}

async function readSettings(): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(join(getAgentDir(), "settings.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

async function resolveToplevel(
  path: string,
  timeoutMs: number,
): Promise<PathResolution> {
  try {
    if (!(await stat(path)).isDirectory()) return { kind: "notRepo" };
  } catch (error) {
    return statResolution(error);
  }
  try {
    return {
      kind: "repo",
      toplevel: await runGit(["rev-parse", "--show-toplevel"], path, timeoutMs),
    };
  } catch (error) {
    if (/not a git repository/i.test(gitErrorDetail(error))) {
      return { kind: "notRepo" };
    }
    return { kind: "failed", detail: gitErrorDetail(error) };
  }
}

async function updateRepo(
  toplevel: string,
  config: GitUpdateConfig,
): Promise<RepoEvent[]> {
  const timeoutMs = config.timeoutMs;

  const branch = await runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    toplevel,
    timeoutMs,
  );
  if (branch === "HEAD") return [{ kind: "detached" }];
  if (!config.mainBranches.includes(branch)) {
    return [{ kind: "notMain", branch }];
  }

  const events: RepoEvent[] = [];

  const status = await runGit(["status", "--porcelain"], toplevel, timeoutMs);
  if (status.length > 0) {
    const files = status.split("\n").filter((line) => line.length > 0).length;
    if (!config.pullDirty) return [{ kind: "dirty", files, skipped: true }];
    events.push({ kind: "dirty", files, skipped: false });
  }

  const headBefore = await runGit(["rev-parse", "HEAD"], toplevel, timeoutMs);
  await runGit(["fetch"], toplevel, timeoutMs);
  const alreadyUpToDate = await mergeUpstream(toplevel, timeoutMs);
  const headAfter = await runGit(["rev-parse", "HEAD"], toplevel, timeoutMs);

  if (headAfter === headBefore || alreadyUpToDate) {
    events.push({ kind: "upToDate" });
    return events;
  }
  const commits = Number(
    await runGit(
      ["rev-list", "--count", `${headBefore}..${headAfter}`],
      toplevel,
      timeoutMs,
    ),
  );
  events.push({ kind: "updated", from: headBefore, to: headAfter, commits });
  return events;
}

async function runUpdate(ctx: ExtensionContext): Promise<void> {
  const config = await loadConfig(ctx);
  const settings = await readSettings();
  const paths = selectSkillPaths(settings, getAgentDir(), config, homedir());

  const resolved = await Promise.all(
    paths.map(async (path) => ({
      path,
      resolution: await resolveToplevel(path, config.timeoutMs),
    })),
  );
  const { repos, invalidPaths, failures } = partitionResolutions(resolved);

  const results = await Promise.allSettled(
    [...repos.entries()].map(async ([toplevel]) => {
      let events: RepoEvent[];
      try {
        events = await updateRepo(toplevel, config);
      } catch (error) {
        events = [{ kind: "error", message: gitErrorDetail(error) }];
      }
      return classifyRepo(basename(toplevel), events);
    }),
  );

  const reports: RepoReport[] = results.map((result) =>
    result.status === "fulfilled"
      ? result.value
      : {
          severity: "error" as Severity,
          text: `skills-git-update: ${errorMessage(result.reason)}`,
        },
  );
  const invalid = aggregateInvalidPaths(invalidPaths);
  if (invalid) reports.push(invalid);
  for (const failure of failures) {
    reports.push({
      severity: "error",
      text: `skills-git-update: git-вызов не удался (${failure.detail}), пути пропущены:\n${failure.paths.join("\n")}`,
    });
  }
  if (reports.length === 0) return;
  const summary = summarizeReports(reports);
  notify(ctx, summary.text, summary.severity);
}

const IN_FLIGHT_KEY = "__skillsGitUpdateInFlight";
const inFlightStore = globalThis as typeof globalThis & {
  [IN_FLIGHT_KEY]?: Promise<void>;
};

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  function startUpdate(ctx: ExtensionContext): Promise<void> {
    const existing = inFlightStore[IN_FLIGHT_KEY];
    if (existing) return existing;
    const run = runUpdate(ctx)
      .catch((error) =>
        notify(ctx, `skills-git-update: ${errorMessage(error)}`),
      )
      .finally(() => {
        inFlightStore[IN_FLIGHT_KEY] = undefined;
      });
    inFlightStore[IN_FLIGHT_KEY] = run;
    return run;
  }

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    void startUpdate(ctx);
  });
}
