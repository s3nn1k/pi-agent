import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateInvalidPaths,
  classifyRepo,
  DEFAULT_CONFIG,
  expandPath,
  formatRepoEvent,
  isAlreadyUpToDate,
  maxSeverity,
  partitionResolutions,
  parseConfig,
  parseSettingsSkills,
  selectSkillPaths,
  summarizeReports,
  statResolution,
  type RepoEvent,
} from "./logic.ts";

const HOME = "/home/user";
const CONFIG = DEFAULT_CONFIG;

describe("expandPath", () => {
  it("раскрывает ~ и ~/...", () => {
    assert.equal(expandPath("~", HOME), HOME);
    assert.equal(
      expandPath("~/projects/skills", HOME),
      "/home/user/projects/skills",
    );
  });

  it("не трогает абсолютные и относительные пути", () => {
    assert.equal(expandPath("/opt/skills", HOME), "/opt/skills");
    assert.equal(expandPath("rel/skills", HOME), "rel/skills");
    assert.equal(expandPath("~/user", HOME), "/home/user/user");
  });
});

describe("parseSettingsSkills", () => {
  it("берёт только корневое поле skills", () => {
    assert.deepEqual(
      parseSettingsSkills({
        skills: ["~/a", "/b"],
        packages: [{ skills: ["ignored"] }],
      }),
      ["~/a", "/b"],
    );
  });

  it("отбрасывает некорректные записи и структуры", () => {
    assert.deepEqual(parseSettingsSkills({ skills: ["ok", "", 42] }), ["ok"]);
    assert.deepEqual(parseSettingsSkills({ skills: "nope" }), []);
    assert.deepEqual(parseSettingsSkills({}), []);
    assert.deepEqual(parseSettingsSkills(null), []);
    assert.deepEqual(parseSettingsSkills("junk"), []);
  });

  it("пустой skills → пустой список", () => {
    assert.deepEqual(parseSettingsSkills({ skills: [] }), []);
  });
});

describe("parseConfig", () => {
  it("полный конфиг парсится как есть", () => {
    assert.deepEqual(
      parseConfig({
        mainBranches: ["trunk"],
        includeAgentDir: false,
        pullDirty: true,
        timeoutMs: 5000,
      }),
      {
        mainBranches: ["trunk"],
        includeAgentDir: false,
        pullDirty: true,
        timeoutMs: 5000,
      },
    );
  });

  it("пустой/отсутствующий конфиг → дефолты", () => {
    assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig("not an object"), DEFAULT_CONFIG);
  });

  it("некорректные поля заменяются дефолтами", () => {
    assert.deepEqual(
      parseConfig({
        mainBranches: [],
        includeAgentDir: "yes",
        pullDirty: 1,
        timeoutMs: -3,
      }),
      DEFAULT_CONFIG,
    );
    assert.deepEqual(parseConfig({ mainBranches: ["main", 7] }), {
      ...DEFAULT_CONFIG,
      mainBranches: ["main", "master"],
    });
  });
});

describe("selectSkillPaths", () => {
  it("раскрывает ~ и дедуплицирует, без agentDir по умолчанию", () => {
    assert.deepEqual(
      selectSkillPaths(
        { skills: ["~/s/a", "~/s/a", "/abs/b"] },
        "/home/user/.pi/agent",
        CONFIG,
        HOME,
      ),
      ["/home/user/s/a", "/abs/b"],
    );
  });

  it("includeAgentDir=true добавляет agentDir", () => {
    assert.deepEqual(
      selectSkillPaths(
        { skills: ["/abs/b"] },
        "/home/user/.pi/agent",
        { ...CONFIG, includeAgentDir: true },
        HOME,
      ),
      ["/abs/b", "/home/user/.pi/agent"],
    );
  });

  it("пустой skills → пустой список", () => {
    assert.deepEqual(
      selectSkillPaths({ skills: [] }, "/agent", CONFIG, HOME),
      [],
    );
  });
});

describe("maxSeverity", () => {
  it("возвращает максимальную severity", () => {
    assert.equal(maxSeverity("info", "warning"), "warning");
    assert.equal(maxSeverity("error", "info"), "error");
    assert.equal(maxSeverity("info", "info"), "info");
  });
});

describe("formatRepoEvent / classifyRepo", () => {
  it("updated", () => {
    const event: RepoEvent = {
      kind: "updated",
      from: "abcdef1234567890",
      to: "1234567890abcdef",
      commits: 3,
    };
    assert.equal(
      formatRepoEvent(event),
      "updated: abcdef1..1234567 (+3 commits)",
    );
    assert.equal(classifyRepo("repo", [event]).severity, "info");
  });

  it("актуальная версия", () => {
    const report = classifyRepo("repo", [{ kind: "upToDate" }]);
    assert.equal(report.severity, "info");
    assert.equal(report.text, "skills-git-update: repo: актуальная версия");
  });

  it("detached HEAD", () => {
    const report = classifyRepo("repo", [{ kind: "detached" }]);
    assert.equal(report.severity, "warning");
    assert.equal(report.text, "skills-git-update: repo: detached HEAD");
  });

  it("не на main", () => {
    const report = classifyRepo("repo", [{ kind: "notMain", branch: "dev" }]);
    assert.equal(report.severity, "warning");
    assert.equal(
      report.text,
      "skills-git-update: repo: не на main (branch: dev), pull пропущен",
    );
  });

  it("dirty со skip и с продолжением", () => {
    const skipped = classifyRepo("repo", [
      { kind: "dirty", files: 2, skipped: true },
    ]);
    assert.equal(skipped.severity, "warning");
    assert.match(skipped.text, /dirty \(2 изм. файлов\), pull пропущен/);
    const continued = classifyRepo("repo", [
      { kind: "dirty", files: 2, skipped: false },
      { kind: "updated", from: "aaaaaaaaaaa", to: "bbbbbbbbbbb", commits: 1 },
    ]);
    assert.equal(continued.severity, "warning");
    assert.match(continued.text, /pull продолжается/);
    assert.match(continued.text, /updated: aaaaaaa..bbbbbbb \(\+1 commits\)/);
  });

  it("ошибка git → error с первой строкой stderr", () => {
    const report = classifyRepo("repo", [
      { kind: "error", message: "fatal: authentication failed" },
    ]);
    assert.equal(report.severity, "error");
    assert.equal(
      report.text,
      "skills-git-update: repo: fatal: authentication failed",
    );
  });

  it("severity агрегируется как максимум", () => {
    const report = classifyRepo("repo", [
      { kind: "upToDate" },
      { kind: "detached" },
    ]);
    assert.equal(report.severity, "warning");
  });
});

describe("isAlreadyUpToDate", () => {
  it("распознаёт Already up to date в любом регистре", () => {
    assert.equal(isAlreadyUpToDate("Already up to date."), true);
    assert.equal(isAlreadyUpToDate("already up to date"), true);
    assert.equal(isAlreadyUpToDate("Fast-forward"), false);
  });
});

describe("statResolution", () => {
  it("EACCES и прочие stat-ошибки классифицируются как failed с деталью", () => {
    assert.deepEqual(statResolution(new Error("EACCES: permission denied")), {
      kind: "failed",
      detail: "EACCES: permission denied",
    });
    assert.deepEqual(statResolution("boom"), {
      kind: "failed",
      detail: "boom",
    });
  });
});

describe("partitionResolutions", () => {
  const repo = (path: string, toplevel: string) => ({
    path,
    resolution: { kind: "repo", toplevel } as const,
  });

  it("репо дедуплицируется по toplevel, notRepo уходит в invalidPaths", () => {
    const result = partitionResolutions([
      repo("/a", "/repo"),
      repo("/b", "/repo"),
      { path: "/file.txt", resolution: { kind: "notRepo" } },
      { path: "/missing", resolution: { kind: "notRepo" } },
    ]);
    assert.deepEqual([...result.repos], [["/repo", "/a"]]);
    assert.deepEqual(result.invalidPaths, ["/file.txt", "/missing"]);
    assert.deepEqual(result.failures, []);
  });

  it("failed группируется по одной причине в один notify", () => {
    const result = partitionResolutions([
      {
        path: "/x",
        resolution: { kind: "failed", detail: "spawn git ENOENT" },
      },
      {
        path: "/y",
        resolution: { kind: "failed", detail: "spawn git ENOENT" },
      },
      {
        path: "/z",
        resolution: { kind: "failed", detail: "ETIMEDOUT" },
      },
    ]);
    assert.deepEqual(result.invalidPaths, []);
    assert.deepEqual(result.repos, new Map());
    assert.deepEqual(result.failures, [
      { detail: "spawn git ENOENT", paths: ["/x", "/y"] },
      { detail: "ETIMEDOUT", paths: ["/z"] },
    ]);
  });

  describe("summarizeReports", () => {
    it("склеивает тексты и берёт максимальную severity", () => {
      const summary = summarizeReports([
        {
          severity: "info",
          text: "skills-git-update: agent: актуальная версия",
        },
        {
          severity: "warning",
          text: "skills-git-update: engineering-standards: не на main (branch: dev), pull пропущен",
        },
      ]);
      assert.equal(summary.severity, "warning");
      assert.equal(
        summary.text,
        "skills-git-update: agent: актуальная версия\nskills-git-update: engineering-standards: не на main (branch: dev), pull пропущен",
      );
    });

    it("info-репорты тоже склеиваются переносами строк", () => {
      assert.deepEqual(
        summarizeReports([
          {
            severity: "info",
            text: "skills-git-update: agent: актуальная версия",
          },
          {
            severity: "info",
            text: "skills-git-update: engineering-standards: актуальная версия",
          },
        ]),
        {
          severity: "info",
          text: "skills-git-update: agent: актуальная версия\nskills-git-update: engineering-standards: актуальная версия",
        },
      );
    });

    it("один info-репорт проходит как есть", () => {
      assert.deepEqual(
        summarizeReports([
          {
            severity: "info",
            text: "skills-git-update: agent: актуальная версия",
          },
        ]),
        {
          severity: "info",
          text: "skills-git-update: agent: актуальная версия",
        },
      );
    });

    it("error доминирует над warning", () => {
      const summary = summarizeReports([
        { severity: "warning", text: "w" },
        { severity: "error", text: "e" },
      ]);
      assert.equal(summary.severity, "error");
    });
  });

  describe("aggregateInvalidPaths", () => {
    it("undefined без путей", () => {
      assert.equal(aggregateInvalidPaths([]), undefined);
    });

    it("агрегирует warn-список", () => {
      const report = aggregateInvalidPaths(["/nope", "/also/nope"]);
      assert.ok(report);
      assert.equal(report.severity, "warning");
      assert.match(report.text, /\/nope\n\/also\/nope/);
    });
  });
});
