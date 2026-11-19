import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerScopeAgentsMd from "./scope-agents-md.ts";

export default function promptShaping(pi: ExtensionAPI): void {
  registerScopeAgentsMd(pi);
}
