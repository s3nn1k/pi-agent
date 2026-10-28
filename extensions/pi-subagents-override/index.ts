import compactSubagentCards from "./compact-subagent-cards.ts";
import { registerCommandFilter } from "./command-filter.ts";
import { registerWorkflowFolding } from "./workflow-folding.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piSubagentsOverride(pi: ExtensionAPI): void {
  let toolsExpanded = false;
  registerWorkflowFolding(pi, () => toolsExpanded);
  compactSubagentCards(pi);
  registerCommandFilter(pi, (expanded) => {
    toolsExpanded = expanded;
  });
}
