// Built-in shortcut defaults, for the bridge to resolve extension keybinding
// conflicts (RF-01-69) without the web bundle. This mirrors
// `defaultShortcutBindings` and `normalizeShortcut` in
// web/src/shortcutBindings.ts, which the web app owns; a server test compares
// the two on every platform so they cannot drift apart.

export type ShortcutPlatform = "mac" | "windows" | "linux";
export const SHORTCUT_PLATFORM_IDS: readonly ShortcutPlatform[] = [
  "mac",
  "windows",
  "linux",
];

const base: Record<string, string[]> = {
  "command.menu": ["Ctrl+Alt+K"],
  "shortcuts.show": ["Ctrl+Alt+Shift+K"],
  "sidebar.toggle": ["Ctrl+Alt+B"],
  "inspector.toggle": ["Ctrl+Alt+Shift+B"],
  "inspector.expand": ["Ctrl+Alt+Shift+Enter"],
  "annotations.toggle": ["Ctrl+Alt+A"],
  "assistant.toggle": ["Ctrl+Alt+Shift+A"],
  "zen.toggle": ["Ctrl+Alt+Z"],
  "panes.recent": ["Ctrl+Alt+J"],
  "plugin.herdrFloat.toggle": ["Ctrl+Alt+F"],
  "panes.search": ["Alt+K"],
  "tab.create": ["Ctrl+Alt+T"],
  "tab.close": ["Ctrl+Alt+W"],
  "tab.previous": ["Alt+Shift+ArrowLeft"],
  "tab.next": ["Alt+Shift+ArrowRight"],
  "pane.left": ["Ctrl+Shift+ArrowLeft"],
  "pane.right": ["Ctrl+Shift+ArrowRight"],
  "pane.up": ["Ctrl+Shift+ArrowUp"],
  "pane.down": ["Ctrl+Shift+ArrowDown"],
  "pane.moveLeft": ["Ctrl+Alt+Shift+ArrowLeft"],
  "pane.moveRight": ["Ctrl+Alt+Shift+ArrowRight"],
  "pane.moveUp": ["Ctrl+Alt+Shift+ArrowUp"],
  "pane.moveDown": ["Ctrl+Alt+Shift+ArrowDown"],
  "pane.splitRight": ["Ctrl+Alt+D"],
  "pane.splitDown": ["Ctrl+Alt+Shift+D"],
  "pane.zoom": ["Ctrl+Alt+Enter"],
  "pane.chat": ["Ctrl+Alt+M"],
  "workspaces.open": ["Ctrl+Alt+O"],
  "files.toggle": ["Ctrl+Alt+E"],
  "diff.toggle": ["Ctrl+Alt+G"],
  "terminal.focus": ["Ctrl+Backquote"],
  "terminal.history": ["Ctrl+Alt+H"],
  "terminal.pageUp": ["PageUp"],
  "terminal.pageDown": ["PageDown"],
  "terminal.halfPageUp": ["Alt+PageUp"],
  "terminal.halfPageDown": ["Alt+PageDown"],
  "terminal.multiline": ["Shift+Enter"],
  "terminal.altEnter": ["Alt+Enter"],
  "terminal.ctrlEnter": ["Ctrl+Enter"],
  "terminal.lineStart": ["Ctrl+A"],
  "terminal.lineEnd": ["Ctrl+E"],
  "terminal.deleteToStart": ["Ctrl+U"],
  "terminal.copy": ["Ctrl+Shift+C", "Ctrl+Insert"],
  "terminal.paste": ["Ctrl+V", "Ctrl+Shift+V"],
  "terminal.link": ["Ctrl+Click"],
  "preview.search": ["Ctrl+F"],
  "preview.selectAll": ["Ctrl+A"],
  "composer.send": ["Ctrl+Enter"],
  "annotation.submit": ["Ctrl+Enter"],
  "annotations.copy": ["Ctrl+Shift+C"],
  "annotations.prefill": ["Ctrl+Enter"],
};

const macOverrides: Record<string, string[]> = {
  "command.menu": ["Meta+K"],
  "shortcuts.show": ["Meta+Shift+K"],
  "sidebar.toggle": ["Meta+B"],
  "inspector.toggle": ["Meta+Shift+B"],
  "inspector.expand": ["Alt+Meta+Enter"],
  "annotations.toggle": ["Alt+Meta+A"],
  "assistant.toggle": ["Alt+Meta+Shift+A"],
  "zen.toggle": ["Meta+Shift+Z"],
  "panes.recent": ["Ctrl+Tab", "Ctrl+Shift+Tab"],
  "plugin.herdrFloat.toggle": ["Ctrl+Meta+F"],
  "tab.create": ["Meta+T"],
  "tab.close": ["Meta+W"],
  "tab.previous": ["Alt+Meta+ArrowLeft"],
  "tab.next": ["Alt+Meta+ArrowRight"],
  "pane.left": ["Ctrl+Meta+ArrowLeft"],
  "pane.right": ["Ctrl+Meta+ArrowRight"],
  "pane.up": ["Ctrl+Meta+ArrowUp"],
  "pane.down": ["Ctrl+Meta+ArrowDown"],
  "pane.moveLeft": ["Ctrl+Meta+Shift+ArrowLeft"],
  "pane.moveRight": ["Ctrl+Meta+Shift+ArrowRight"],
  "pane.moveUp": ["Ctrl+Meta+Shift+ArrowUp"],
  "pane.moveDown": ["Ctrl+Meta+Shift+ArrowDown"],
  "pane.splitRight": ["Meta+D"],
  "pane.splitDown": ["Meta+Shift+D"],
  "pane.zoom": ["Meta+Shift+Enter"],
  "pane.chat": ["Ctrl+Meta+M"],
  "workspaces.open": ["Ctrl+Shift+W"],
  "files.toggle": ["Meta+Shift+E"],
  "diff.toggle": ["Ctrl+Shift+G"],
  "terminal.history": ["Meta+Shift+H"],
  "terminal.lineStart": ["Meta+ArrowLeft", "Meta+ArrowUp"],
  "terminal.lineEnd": ["Meta+ArrowRight", "Meta+ArrowDown"],
  "terminal.deleteToStart": ["Meta+Backspace"],
  "terminal.copy": ["Meta+C"],
  "terminal.paste": ["Meta+V"],
  "terminal.link": ["Meta+Click"],
  "preview.search": ["Meta+F"],
  "preview.selectAll": ["Meta+A"],
  "composer.send": ["Meta+Enter"],
  "annotation.submit": ["Meta+Enter"],
  "annotations.copy": ["Meta+Shift+C"],
  "annotations.prefill": ["Meta+Enter"],
};

const SHORTCUT_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Built-in shortcut id -> default keys on `platform`. */
export function builtinShortcutBindings(
  platform: ShortcutPlatform,
): Record<string, string[]> {
  const bindings = Object.fromEntries(
    Object.entries(base).map(([id, keys]) => [id, [...keys]]),
  );
  for (const n of SHORTCUT_DIGITS) {
    bindings[`tab.${n}`] = [`${platform === "mac" ? "Ctrl" : "Ctrl+Alt"}+${n}`];
    bindings[`command.${n}`] = [`Alt+${n}`];
  }
  if (platform === "linux")
    Object.assign(bindings, {
      "tab.create": ["Ctrl+Alt+Shift+T"],
      "pane.splitRight": ["Ctrl+Alt+Shift+D"],
      "pane.splitDown": ["Ctrl+Alt+Shift+S"],
    });
  if (platform === "windows") bindings["terminal.paste"] = ["Ctrl+V"];
  if (platform === "mac")
    for (const [id, keys] of Object.entries(macOverrides))
      bindings[id] = [...keys];
  return bindings;
}

/**
 * Whether a global shortcut can collide with built-in `id`. Numbered command
 * menu actions only fire while the menu is open, so they never collide.
 */
export function builtinCollidesWithGlobal(id: string): boolean {
  return !/^command\.[1-9]$/.test(id);
}

const MODIFIERS = ["Ctrl", "Alt", "Meta", "Shift"] as const;
const MODIFIER_ALIASES: Record<string, string> = {
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
const NAMED_KEYS = [
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

/**
 * The canonical `Ctrl+Alt+Meta+Shift+Key` form the web app matches against, or
 * null. `mod` is Meta on macOS and Ctrl elsewhere.
 */
export function normalizeShortcut(
  value: string,
  platform: ShortcutPlatform = "linux",
): string | null {
  const parts = value
    .trim()
    .split("+")
    .map((part) => part.trim());
  const key = parts.pop() ?? "";
  const mods = parts.map((part) =>
    part.toLowerCase() === "mod"
      ? platform === "mac"
        ? "Meta"
        : "Ctrl"
      : MODIFIER_ALIASES[part.toLowerCase()],
  );
  if (mods.some((mod) => !mod) || new Set(mods).size !== mods.length)
    return null;
  const normalized =
    /^[a-z0-9]$/i.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/i.test(key)
      ? key.toUpperCase()
      : NAMED_KEYS.find((name) => name.toLowerCase() === key.toLowerCase());
  if (!normalized) return null;
  return [...MODIFIERS.filter((mod) => mods.includes(mod)), normalized].join(
    "+",
  );
}
