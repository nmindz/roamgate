import { builtinShortcutBindings } from "../../shared/shortcuts";
export type ShortcutPlatform = "mac" | "windows" | "linux";
export const SHORTCUT_PLATFORMS: Record<ShortcutPlatform, string> = {
  mac: "macOS / iOS",
  windows: "Windows",
  linux: "Linux / Android",
};

export function detectShortcutPlatform(
  nav: {
    platform?: string;
    userAgent?: string;
    userAgentData?: { platform?: string };
  } = typeof navigator === "undefined" ? {} : navigator,
): ShortcutPlatform {
  const platform = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) return "mac";
  if (/Win/i.test(platform)) return "windows";
  return "linux";
}

type BaseShortcutId =
  | "command.menu"
  | "shortcuts.show"
  | "sidebar.toggle"
  | "inspector.toggle"
  | "inspector.expand"
  | "annotations.toggle"
  | "assistant.toggle"
  | "zen.toggle"
  | "panes.recent"
  | "plugin.herdrFloat.toggle"
  | "panes.search"
  | "tab.create"
  | "tab.close"
  | "tab.previous"
  | "tab.next"
  | "pane.left"
  | "pane.right"
  | "pane.up"
  | "pane.down"
  | "pane.moveLeft"
  | "pane.moveRight"
  | "pane.moveUp"
  | "pane.moveDown"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.zoom"
  | "pane.chat"
  | "workspaces.open"
  | "files.toggle"
  | "diff.toggle"
  | "terminal.focus"
  | "terminal.history"
  | "terminal.pageUp"
  | "terminal.pageDown"
  | "terminal.halfPageUp"
  | "terminal.halfPageDown"
  | "terminal.multiline"
  | "terminal.altEnter"
  | "terminal.ctrlEnter"
  | "terminal.lineStart"
  | "terminal.lineEnd"
  | "terminal.deleteToStart"
  | "terminal.copy"
  | "terminal.paste"
  | "terminal.link"
  | "preview.search"
  | "preview.selectAll"
  | "composer.send"
  | "annotation.submit"
  | "annotations.copy"
  | "annotations.prefill";
export type ShortcutNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type ShortcutId =
  | BaseShortcutId
  | `tab.${ShortcutNumber}`
  | `command.${ShortcutNumber}`;
export type ShortcutBindings = Record<ShortcutId, string[]>;
export const SHORTCUT_NUMBERS: ShortcutNumber[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const SHORTCUT_IDS = Object.keys(
  builtinShortcutBindings("linux"),
) as ShortcutId[];

export function defaultShortcutBindings(
  platform: ShortcutPlatform,
): ShortcutBindings {
  return builtinShortcutBindings(platform) as ShortcutBindings;
}

const modifiers = ["Ctrl", "Alt", "Meta", "Shift"] as const;
const modifierAliases: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
  super: "Meta",
  shift: "Shift",
};
const namedKeys = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Insert",
  "Space",
  "Click",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Backquote",
];

export function normalizeShortcut(value: string): string | null {
  const parts = value
    .trim()
    .split("+")
    .map((part) => part.trim());
  const key = parts.pop() ?? "";
  const mods = parts.map((part) => modifierAliases[part.toLowerCase()]);
  if (mods.some((mod) => !mod) || new Set(mods).size !== mods.length)
    return null;
  const normalized =
    /^[a-z0-9]$/i.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/i.test(key)
      ? key.toUpperCase()
      : namedKeys.find((name) => name.toLowerCase() === key.toLowerCase());
  if (!normalized) return null;
  return [...modifiers.filter((mod) => mods.includes(mod)), normalized].join(
    "+",
  );
}

export type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"
> &
  Partial<
    Pick<
      KeyboardEvent,
      "code" | "isComposing" | "keyCode" | "type" | "getModifierState"
    >
  >;
export function shortcutFromEvent(event: ShortcutEvent): string | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.type && !["keydown", "keyup"].includes(event.type)) return null;
  // Chromium on Windows AltGr layouts reports AltGraph for plain Ctrl+Alt, so
  // only treat AltGraph as text input when it yields an alternate character
  // (AltGr+2 → "@"), not for named keys or code-matching letters (Ctrl+Alt+K).
  if (event.getModifierState?.("AltGraph")) {
    const codeKey =
      event.code && /^(Key[A-Z]|Digit[0-9])$/.test(event.code)
        ? event.code.replace(/^(Key|Digit)/, "")
        : null;
    if (
      event.key.length === 1 &&
      codeKey !== null &&
      event.key.toUpperCase() !== codeKey
    )
      return null;
  }
  let key = event.key;
  // Modifier-produced characters (Option+1, Shift+2) still address the same key.
  if (event.code && /^(Key[A-Z]|Digit[0-9])$/.test(event.code))
    key = event.code.replace(/^(Key|Digit)/, "");
  else if (event.code === "NumpadEnter") key = "Enter";
  else if (event.code && namedKeys.includes(event.code)) key = event.code;
  if (key === " ") key = "Space";
  return normalizeShortcut(
    [
      event.ctrlKey ? "Ctrl" : "",
      event.altKey ? "Alt" : "",
      event.metaKey ? "Meta" : "",
      event.shiftKey ? "Shift" : "",
      key,
    ]
      .filter(Boolean)
      .join("+"),
  );
}

export function matchesShortcut(
  event: ShortcutEvent,
  id: ShortcutId,
  bindings: ShortcutBindings,
): boolean {
  const key = shortcutFromEvent(event);
  return key !== null && bindings[id].includes(key);
}

const keySymbols: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

export function formatShortcut(
  binding: string,
  platform: ShortcutPlatform,
): string {
  return binding
    .split("+")
    .map(
      (part) =>
        keySymbols[part] ??
        (part === "Meta"
          ? platform === "mac"
            ? "Cmd"
            : platform === "windows"
              ? "Win"
              : "Super"
          : part === "Alt" && platform === "mac"
            ? "Option"
            : part.replace("Arrow", "")),
    )
    .join("+");
}

export function shortcutScope(id: ShortcutId): string {
  if (id.startsWith("command.") && id !== "command.menu") return "command";
  if (
    id === "terminal.focus" ||
    id === "terminal.history" ||
    id === "annotations.toggle"
  )
    return "global";
  if (/^(terminal|preview|composer|annotation|annotations)\./.test(id))
    return id.split(".")[0];
  return "global";
}

export function shortcutConflicts(
  id: ShortcutId,
  keys: string[],
  bindings: ShortcutBindings,
): ShortcutId[] {
  const scope = shortcutScope(id);
  return SHORTCUT_IDS.filter((other) => {
    if (other === id) return false;
    const otherScope = shortcutScope(other);
    // The command popover suspends workspace shortcuts; its own toggle remains active.
    if (scope === "command" || otherScope === "command") {
      if (
        scope !== otherScope &&
        id !== "command.menu" &&
        other !== "command.menu"
      )
        return false;
    } else if (
      scope !== otherScope &&
      scope !== "global" &&
      otherScope !== "global"
    )
      return false;
    return keys.some((key) => bindings[other].includes(key));
  });
}

export function validateShortcutKeys(id: ShortcutId, keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length > 3)
    throw new Error("Use up to three shortcuts per action.");
  const normalized = keys.map((key) =>
    typeof key === "string" ? normalizeShortcut(key) : null,
  );
  if (normalized.some((key) => !key))
    throw new Error(
      "Use a key combination such as Ctrl+Alt+K. Escape is reserved for dismissal.",
    );
  const result = [...new Set(normalized as string[])];
  for (const key of result) {
    if ((id === "terminal.link") !== key.endsWith("Click"))
      throw new Error(
        "Use a modified Click for terminal links and keyboard keys for other actions.",
      );
    if (
      !/^(Ctrl|Alt|Meta)\+/.test(key) &&
      !/^(Shift\+)?(F\d+|PageUp|PageDown|Home|End|Insert|Delete|Enter|Backspace|Arrow\w+)$/.test(
        key,
      )
    ) {
      throw new Error(
        "Add Ctrl, Alt, or Cmd/Win to printable keys so typing remains available.",
      );
    }
    if (key.endsWith("Click") && !key.includes("+"))
      throw new Error("Choose a modifier for clicking links.");
    if (
      shortcutScope(id) === "global" &&
      !key.includes("+") &&
      !/^F\d+$/.test(key)
    )
      throw new Error("Global shortcuts need a modifier or a function key.");
  }
  return result;
}

export function shortcutWarning(keys: string[]): string | null {
  if (
    keys.some(
      (key) =>
        /^(Meta|Ctrl)\+(?:Shift\+)?(?:T|W|N|L|R|P|D|[1-9]|Tab)$/.test(key) ||
        /^(?:Alt\+F4|Meta\+Q|F[15]|F11|F12)$/.test(key),
    )
  )
    return "Your browser or operating system may reserve this combination. Use Record to check whether this page receives it.";
  return null;
}
