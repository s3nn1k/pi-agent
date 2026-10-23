import { dirname, resolve, sep } from "node:path";
import {
  formatSkillsForPrompt,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const AGENT_DIR = resolve(getAgentDir());
const CONTEXT_REGION_REGEX = /<project_context>[\s\S]*<\/project_context>/g;
const INSTRUCTION_PATH_REGEX =
  /<project_instructions path=(?:"([^"]*)"|'([^']*)'|([^\s>]*))/g;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const opts = event.systemPromptOptions;
    let prompt = event.systemPrompt;

    const contextFiles = opts.contextFiles ?? [];
    const keptFiles = contextFiles.filter((f) =>
      isWithin(resolve(dirname(f.path)), AGENT_DIR),
    );
    const foreignFiles = contextFiles.filter(
      (f) => !isWithin(resolve(dirname(f.path)), AGENT_DIR),
    );

    if (foreignFiles.length > 0) {
      const block = buildContextBlock(contextFiles);
      const keptBlock = buildContextBlock(keptFiles);
      if (block !== "" && prompt.includes(block)) {
        prompt = prompt.replace(block, () => keptBlock);
      } else {
        prompt = prompt.replace(CONTEXT_REGION_REGEX, () =>
          contextRegion(keptFiles),
        );
      }
      const keptPaths = new Set(keptFiles.map((f) => f.path));
      const leftoverPaths = [...prompt.matchAll(INSTRUCTION_PATH_REGEX)].map(
        (m) => m[1] ?? m[2] ?? m[3] ?? "",
      );
      if (leftoverPaths.some((p) => !keptPaths.has(p))) {
        prompt = prompt.replace(CONTEXT_REGION_REGEX, "");
      }
    }

    const skills = opts.skills ?? [];
    const keptSkills = skills.filter((s) =>
      isWithin(resolve(dirname(s.filePath)), AGENT_DIR),
    );
    const foreignSkills = skills.filter(
      (s) => !isWithin(resolve(dirname(s.filePath)), AGENT_DIR),
    );
    if (foreignSkills.length > 0) {
      const skillsBlock = formatSkillsForPrompt(skills);
      const keptSkillsBlock = formatSkillsForPrompt(keptSkills);
      if (skillsBlock !== "" && prompt.includes(skillsBlock)) {
        prompt = prompt.replace(skillsBlock, () => keptSkillsBlock);
      } else {
        prompt = prompt.replace(
          /\n*The following skills provide specialized instructions[\s\S]*?<\/available_skills>/,
          () => keptSkillsBlock,
        );
      }
      if (
        foreignSkills.some(
          (s) => prompt.includes(s.filePath) || prompt.includes(`>${s.name}<`),
        )
      ) {
        prompt = prompt.replace(
          /\n*The following skills provide specialized instructions[\s\S]*?<\/available_skills>\n*/,
          "",
        );
        prompt = prompt.replace(
          /\n*<available_skills>[\s\S]*?<\/available_skills>\n*/,
          "",
        );
      }
    }

    if (prompt === event.systemPrompt) return;
    return { systemPrompt: prompt };
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const insideRepo = isWithin(resolve(ctx.cwd), AGENT_DIR);
    ctx.ui.setWidget(
      "scope-agents-md",
      insideRepo
        ? undefined
        : (_tui, theme) => new Text(theme.fg("dim", "ctx: agent-only"), 0, 0),
      { placement: "belowEditor" },
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI)
      ctx.ui.setWidget("scope-agents-md", undefined, {
        placement: "belowEditor",
      });
  });
}

function buildContextBlock(files: Array<{ path: string; content: string }>) {
  const region = contextRegion(files);
  return region === "" ? "" : `\n\n${region}\n`;
}

function contextRegion(files: Array<{ path: string; content: string }>) {
  if (files.length === 0) return "";
  let block =
    "<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const { path, content } of files) {
    block += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
  }
  return `${block}</project_context>`;
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}
