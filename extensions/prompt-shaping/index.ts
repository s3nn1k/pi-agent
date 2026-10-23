import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerScopeAgentsMd from "./scope-agents-md.ts";
import registerSkillsPrompt from "./skills-prompt.ts";

export default function promptShaping(pi: ExtensionAPI): void {
  registerScopeAgentsMd(pi);
  registerSkillsPrompt(pi);
}
