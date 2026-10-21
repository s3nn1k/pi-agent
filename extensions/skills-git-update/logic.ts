export type Severity = "info" | "warning" | "error";

export interface GitUpdateConfig {
  mainBranches: string[];
  includeAgentDir: boolean;
  pullDirty: boolean;
  timeoutMs: number;
}

export const DEFAULT_CONFIG: GitUpdateConfig = {
  mainBranches: ["main", "master"],
  includeAgentDir: false,
  pullDirty: false,
  timeoutMs: 20_000,
};

export type RepoEvent =
  | { kind: "updated"; from: string; to: string; commits: number }
  | { kind: "upToDate" }
  | { kind: "detached" }
  | { kind: "notMain"; branch: string }
  | { kind: "dirty"; files: number; skipped: boolean }
  | { kind: "error"; message: string };

export interface RepoReport {
  severity: Severity;
  text: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function expandPath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path;
}

export function parseSettingsSkills(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const skills = (raw as Record<string, unknown>).skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

export function parseConfig(raw: unknown): GitUpdateConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_CONFIG };
  }
  const record = raw as Record<string, unknown>;
  const mainBranches =
    Array.isArray(record.mainBranches) &&
    record.mainBranches.length > 0 &&
    record.mainBranches.every((b) => typeof b === "string" && b.length > 0)
      ? (record.mainBranches as string[])
      : DEFAULT_CONFIG.mainBranches;
  return {
    mainBranches,
    includeAgentDir:
      typeof record.includeAgentDir === "boolean"
        ? record.includeAgentDir
        : DEFAULT_CONFIG.includeAgentDir,
    pullDirty:
      typeof record.pullDirty === "boolean"
        ? record.pullDirty
        : DEFAULT_CONFIG.pullDirty,
    timeoutMs:
      typeof record.timeoutMs === "number" &&
      Number.isFinite(record.timeoutMs) &&
      record.timeoutMs > 0
        ? record.timeoutMs
        : DEFAULT_CONFIG.timeoutMs,
  };
}

export function selectSkillPaths(
  settingsRaw: unknown,
  agentDir: string,
  config: GitUpdateConfig,
  home: string,
): string[] {
  const paths = parseSettingsSkills(settingsRaw).map((p) =>
    expandPath(p, home),
  );
  if (config.includeAgentDir) paths.push(agentDir);
  return [...new Set(paths)];
}

export function formatRepoEvent(event: RepoEvent): string {
  switch (event.kind) {
    case "updated":
      return `updated: ${shortSha(event.from)}..${shortSha(event.to)} (+${event.commits} commits)`;
    case "upToDate":
      return "актуальная версия";
    case "detached":
      return "detached HEAD";
    case "notMain":
      return `не на main (branch: ${event.branch}), pull пропущен`;
    case "dirty":
      return event.skipped
        ? `dirty (${event.files} изм. файлов), pull пропущен`
        : `dirty (${event.files} изм. файлов), pull продолжается`;
    case "error":
      return event.message;
  }
}

export function classifyRepo(
  repoName: string,
  events: RepoEvent[],
): RepoReport {
  let severity: Severity = "info";
  const lines: string[] = [];
  for (const event of events) {
    const eventSeverity: Severity =
      event.kind === "error"
        ? "error"
        : event.kind === "updated" || event.kind === "upToDate"
          ? "info"
          : "warning";
    severity = maxSeverity(severity, eventSeverity);
    lines.push(formatRepoEvent(event));
  }
  return {
    severity,
    text: `skills-git-update: ${repoName}: ${lines.join("; ")}`,
  };
}

export type PathResolution =
  | { kind: "repo"; toplevel: string }
  | { kind: "notRepo" }
  | { kind: "failed"; detail: string };

export interface PathResolutionEntry {
  path: string;
  resolution: PathResolution;
}

export interface PartitionedResolutions {
  repos: Map<string, string>;
  invalidPaths: string[];
  failures: { detail: string; paths: string[] }[];
}

export function isAlreadyUpToDate(mergeOutput: string): boolean {
  return /already up to date/i.test(mergeOutput);
}

export function statResolution(error: unknown): PathResolution {
  return {
    kind: "failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

export function partitionResolutions(
  resolved: PathResolutionEntry[],
): PartitionedResolutions {
  const repos = new Map<string, string>();
  const invalidPaths: string[] = [];
  const failureIndex = new Map<string, string[]>();
  for (const { path, resolution } of resolved) {
    if (resolution.kind === "repo") {
      if (!repos.has(resolution.toplevel)) {
        repos.set(resolution.toplevel, path);
      }
    } else if (resolution.kind === "notRepo") {
      invalidPaths.push(path);
    } else {
      const paths = failureIndex.get(resolution.detail) ?? [];
      paths.push(path);
      failureIndex.set(resolution.detail, paths);
    }
  }
  return {
    repos,
    invalidPaths,
    failures: [...failureIndex].map(([detail, paths]) => ({ detail, paths })),
  };
}

export function summarizeReports(reports: RepoReport[]): RepoReport {
  const severity = reports.reduce<Severity>(
    (acc, report) => maxSeverity(acc, report.severity),
    "info",
  );
  return {
    severity,
    text: reports.map((report) => report.text).join("\n"),
  };
}

export function aggregateInvalidPaths(paths: string[]): RepoReport | undefined {
  if (paths.length === 0) return undefined;
  return {
    severity: "warning",
    text: `skills-git-update: пути вне git-репозиториев, пропущены:\n${paths.join("\n")}`,
  };
}
