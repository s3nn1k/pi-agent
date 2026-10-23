import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCompactToolRendererResolver } from "./renderers.ts";

export default function compactToolResults(pi: ExtensionAPI): void {
  pi.registerToolRenderer(createCompactToolRendererResolver());
}
