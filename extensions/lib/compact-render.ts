import { keyHint } from "@earendil-works/pi-coding-agent";

export function textBlocksOf(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : [],
  );
}

export function contentTextOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return textBlocksOf(content).join("\n");
}

export function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function expandHint(): string {
  return keyHint("app.tools.expand", "to expand");
}
