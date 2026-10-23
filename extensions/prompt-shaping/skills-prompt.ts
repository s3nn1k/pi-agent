import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SkillCard {
  name: string;
  description?: string;
  filePath?: string;
  disableModelInvocation?: boolean;
}

const INTRO =
  "The following skills provide specialized instructions for specific tasks. " +
  "Use the read tool to load a skill's file when the task matches its description. " +
  "When a skill file references a relative path, resolve it against the skill directory " +
  "(parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSkillsBlock(skills: SkillCard[], withIntro: boolean): string {
  const entries = skills
    .map((skill) => {
      const description = escapeXml(skill.description ?? "");
      const location = escapeXml(skill.filePath ?? "");
      return `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${description}</description>\n    <location>${location}</location>\n  </skill>`;
    })
    .join("\n");
  const intro = withIntro ? `\n\n${INTRO}` : "";
  return `${intro}\n\n<available_skills>\n${entries}\n</available_skills>`;
}

function parseSkillEntries(
  block: string,
): { card: string; location: string }[] {
  const entries: { card: string; location: string }[] = [];
  const re = /[ \t]*<skill>\n[\s\S]*?<\/skill>\n?/g;
  for (const match of block.matchAll(re)) {
    const card = match[0];
    const location = /<location>([\s\S]*?)<\/location>/.exec(card)?.[1] ?? "";
    entries.push({ card, location });
  }
  return entries;
}

function stripProjectSkills(
  systemPrompt: string,
  allowedPrefix: string,
): string {
  return systemPrompt.replace(
    /<available_skills>\n([\s\S]*?)\n<\/available_skills>/g,
    (_whole, inner: string) => {
      const kept = parseSkillEntries(inner)
        .filter((entry) => entry.location.startsWith(allowedPrefix))
        .map((entry) => entry.card.trimEnd())
        .join("\n");
      return kept ? `<available_skills>\n${kept}\n</available_skills>` : "";
    },
  );
}

function settingsSkillPrefixes(): string[] {
  try {
    const settingsPath = path.join(os.homedir(), ".pi/agent/settings.json");
    const skills =
      JSON.parse(fs.readFileSync(settingsPath, "utf8")).skills ?? [];
    return skills
      .filter((entry: unknown): entry is string => typeof entry === "string")
      .map((entry: string) =>
        entry.replace(/^~/, os.homedir()).replace(/\/+$/, ""),
      );
  } catch (error) {
    console.error("[skills-prompt] settings.json parse failed:", error);
    return [];
  }
}

export default function (pi: {
  on: (
    event: "before_agent_start",
    handler: (event: unknown, ctx: ExtensionContext) => Promise<object | void>,
  ) => void;
}) {
  pi.on("before_agent_start", async (event: unknown) => {
    const promptEvent = event as {
      systemPrompt?: string;
      systemPromptOptions?: { skills?: SkillCard[] };
    };
    const systemPrompt = promptEvent.systemPrompt;
    if (!systemPrompt) return;
    const allowedPrefix = `${process.env.HOME}/.pi/agent/`;
    const settingsPrefixes = settingsSkillPrefixes();
    let next = stripProjectSkills(systemPrompt, allowedPrefix);
    const hasSkillsSection = next.includes("<available_skills>");
    const missing = (promptEvent.systemPromptOptions?.skills ?? [])
      .filter((skill) => !skill.disableModelInvocation)
      .filter(
        (skill) => (skill.filePath ?? "").startsWith(allowedPrefix) === false,
      )
      .filter((skill) =>
        settingsPrefixes.some((prefix) =>
          (skill.filePath ?? "").startsWith(prefix),
        ),
      )
      .filter((skill) => !next.includes(`<name>${skill.name}</name>`));
    if (missing.length > 0) {
      next += renderSkillsBlock(missing, !hasSkillsSection);
    }
    if (next === systemPrompt) return;
    return { systemPrompt: next };
  });
}
