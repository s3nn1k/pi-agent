import {
  CustomEditor,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Key,
  type AutocompleteProvider,
  type TUI,
} from "@earendil-works/pi-tui";

const SUBAGENT_COMMANDS = [
  "subagents",
  "run",
  "subagent-cost",
  "subagents-doctor",
  "subagents-inspect-rpc",
  "subagents-guide",
  "subagents-refine",
  "subagents-fleet",
  "subagents-detach",
  "subagents-stop",
  "subagents-steer",
  "subagents-models",
  "subagents-profiles",
  "subagents-load-profile",
  "subagents-refresh-provider-models",
  "subagents-generate-profiles",
  "subagents-check-profile",
  "subagents-watchdog",
  "prompt-workflow",
  "pi-subagents-bridge",
];

const MODEL_COMMANDS = ["model", "scoped-models"];

const BLOCKED_COMMANDS = new Set([...SUBAGENT_COMMANDS, ...MODEL_COMMANDS]);

let notifyBlockedCommand: ((command: string) => void) | undefined;

export function setBlockedCommandNotifier(
  notify: (command: string) => void,
): void {
  notifyBlockedCommand = notify;
}

export function blockedCommandOf(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const name = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
  const bare = name.replace(/:\d+$/, "");
  return BLOCKED_COMMANDS.has(bare) && bare !== "" ? bare : undefined;
}

class CommandFilterEditor extends CustomEditor {
  private readonly onInputHandled: () => void;

  constructor(
    tui: TUI,
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    onInputHandled: () => void,
  ) {
    super(tui, theme, keybindings);
    this.onInputHandled = onInputHandled;
  }

  override handleInput(data: string): void {
    const blocked = blockedCommandOf(this.getText());
    if (blocked !== undefined && matchesKey(data, Key.enter)) {
      notifyBlockedCommand?.(blocked);
      return;
    }
    super.handleInput(data);
    this.onInputHandled();
  }
}

function filteredAutocompleteProvider(
  provider: AutocompleteProvider,
): AutocompleteProvider {
  return {
    triggerCharacters: provider.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await provider.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );
      if (suggestions === null) {
        return null;
      }
      const firstLine = (lines[0] ?? "").trimStart();
      const firstToken = firstLine.startsWith("/")
        ? (firstLine.slice(1).split(/\s/, 1)[0] ?? "")
        : "";
      if (
        firstToken !== "" &&
        BLOCKED_COMMANDS.has(firstToken.replace(/:\d+$/, ""))
      ) {
        return null;
      }
      if (
        suggestions.prefix.startsWith("/") &&
        !suggestions.prefix.includes(" ")
      ) {
        const items = suggestions.items.filter(
          (item) => !BLOCKED_COMMANDS.has(item.value),
        );
        return items.length > 0 ? { ...suggestions, items } : null;
      }
      return suggestions;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return provider.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },
    ...(provider.shouldTriggerFileCompletion
      ? {
          shouldTriggerFileCompletion:
            provider.shouldTriggerFileCompletion.bind(provider),
        }
      : {}),
  };
}

export function registerCommandFilter(
  pi: ExtensionAPI,
  onToolsExpandedChange: (expanded: boolean) => void,
): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      return;
    }
    let active = true;
    let toolsExpanded = ctx.ui.getToolsExpanded();
    onToolsExpandedChange(toolsExpanded);
    let editorKeybindings: ConstructorParameters<typeof CustomEditor>[2];
    let editorTui: TUI | undefined;
    const refresh = () => {
      if (!active || editorTui === undefined) return;
      const nextToolsExpanded = ctx.ui.getToolsExpanded();
      if (nextToolsExpanded === toolsExpanded) return;
      toolsExpanded = nextToolsExpanded;
      onToolsExpandedChange(nextToolsExpanded);
      editorTui.invalidate();
      editorTui.requestRender();
    };
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editorKeybindings = keybindings;
      editorTui = tui;
      return new CommandFilterEditor(tui, theme, keybindings, refresh);
    });
    const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
      if (editorKeybindings?.matches(data, "app.tools.expand")) {
        queueMicrotask(refresh);
      }
    });
    pi.on("session_shutdown", () => {
      active = false;
      unsubscribeInput();
    });
    ctx.ui.addAutocompleteProvider((provider) =>
      filteredAutocompleteProvider(provider),
    );
    setBlockedCommandNotifier((command) => {
      ctx.ui.notify(`/${command} отключён (pi-subagents-override)`, "info");
    });
  });
}
