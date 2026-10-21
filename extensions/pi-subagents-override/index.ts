import compactSubagentCards from "./compact-subagent-cards.ts";
import { registerCommandFilter } from "./command-filter.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piSubagentsOverride(pi: ExtensionAPI): void {
  compactSubagentCards(pi);
  registerCommandFilter(pi);
}
