import type {
  ExtensionKeybindingState,
  ExtensionStateResult,
} from "../../../shared/extensions";
import { addListener } from "../../../shared/listeners";
import { bridge } from "../api";
import { roamgateLocalStorage } from "../browserStorage";
import {
  matchesShortcut,
  SHORTCUT_IDS,
  type ShortcutPlatform,
  shortcutFromEvent,
  validateShortcutKeys,
} from "../shortcutBindings";
import { getShortcutSnapshot } from "../shortcutPreferences";
import { store } from "../store";
import { pluginInvocationContext } from "./plugins";
import { runCommandNotify } from "./run";
import { getExtensionsState } from "./state";

// Outside the closed core ShortcutId set so extensions and plugins can add ids
// at runtime. Precedence: core shortcut > user binding > extension default.

export const DYNAMIC_SHORTCUTS_KEY = "dynamicShortcuts.v1";

export const extensionShortcutId = (ext: string, command: string) =>
  `ext:${ext}:${command}`;
export const herdrShortcutId = (plugin: string, action: string) =>
  `herdr:${plugin}.${action}`;

export type ParsedShortcutId =
  | { kind: "ext"; ext: string; command: string }
  | { kind: "herdr"; plugin: string; action: string };

export function parseShortcutId(id: string): ParsedShortcutId | null {
  const ext = /^ext:([^:]+):([^:]+)$/.exec(id);
  if (ext) return { kind: "ext", ext: ext[1], command: ext[2] };
  const herdr = /^herdr:(.+)\.([^.]+)$/.exec(id);
  if (herdr) return { kind: "herdr", plugin: herdr[1], action: herdr[2] };
  return null;
}

type UserBindings = Record<string, string[]>;
const listeners = new Set<() => void>();

export function readUserBindings(): UserBindings {
  try {
    const parsed = JSON.parse(
      roamgateLocalStorage.getItem(DYNAMIC_SHORTCUTS_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const result: UserBindings = {};
    for (const [id, keys] of Object.entries(parsed))
      if (
        parseShortcutId(id) &&
        Array.isArray(keys) &&
        keys.every((key) => typeof key === "string")
      )
        result[id] = keys as string[];
    return result;
  } catch {
    return {};
  }
}

function writeUserBindings(bindings: UserBindings) {
  if (Object.keys(bindings).length === 0)
    roamgateLocalStorage.removeItem(DYNAMIC_SHORTCUTS_KEY);
  else
    roamgateLocalStorage.setItem(
      DYNAMIC_SHORTCUTS_KEY,
      JSON.stringify(bindings),
    );
  listeners.forEach((listener) => listener());
  installKeybindings();
}

export const subscribeDynamicShortcuts = (listener: () => void) =>
  addListener(listeners, listener);

/** Why `key` cannot be bound to `id`, or null: core shortcuts and other users' keys win. */
export function bindingError(id: string, key: string): string | null {
  try {
    validateShortcutKeys("shortcuts.show", [key]);
  } catch (error) {
    return (error as Error).message;
  }
  const { preset } = getShortcutSnapshot();
  const core = SHORTCUT_IDS.find((other) =>
    preset.bindings[other].includes(key),
  );
  if (core)
    return `Already used by the built-in shortcut ${core}. Change that first.`;
  for (const [other, keys] of Object.entries(readUserBindings()))
    if (other !== id && keys.includes(key)) return `Already bound to ${other}.`;
  return null;
}

/** `keys` empty unbinds the command; use `resetUserBinding` to fall back to its default. */
export function setUserBinding(id: string, keys: string[]) {
  const checked = validateShortcutKeys("shortcuts.show", keys);
  for (const key of checked) {
    const error = bindingError(id, key);
    if (error) throw new Error(error);
  }
  writeUserBindings({ ...readUserBindings(), [id]: checked });
}

export function resetUserBinding(id: string) {
  const rest = { ...readUserBindings() };
  delete rest[id];
  writeUserBindings(rest);
}

export interface BoundKey {
  id: string;
  source: "user" | "extension";
}

export interface DroppedDefault {
  id: string;
  key: string;
  /** Who kept the key. */
  reason: string;
}

export interface EffectiveBindings {
  byKey: Map<string, BoundKey>;
  dropped: DroppedDefault[];
}

/** Extension defaults on this platform, minus anything a user binding overrides. */
export function effectiveBindings(
  state: ExtensionStateResult | null,
  platform: ShortcutPlatform,
  user: UserBindings = readUserBindings(),
): EffectiveBindings {
  const byKey = new Map<string, BoundKey>();
  const dropped: DroppedDefault[] = [];
  for (const [id, keys] of Object.entries(user))
    for (const key of keys)
      if (!byKey.has(key)) byKey.set(key, { id, source: "user" });
  if (state && !state.safe_mode)
    for (const entry of state.extensions) {
      if (!entry.enabled) continue;
      for (const binding of entry.contributions.keybindings) {
        const id = extensionShortcutId(entry.id, binding.command);
        if (id in user) continue;
        const lost = binding.conflicts?.find(
          (item) => item.platform === platform,
        );
        const key = binding.keys?.[platform];
        if (!key) continue;
        if (lost) {
          dropped.push({ id, key, reason: `${lost.winner} keeps it` });
          continue;
        }
        const owner = byKey.get(key);
        if (owner) {
          dropped.push({ id, key, reason: `${owner.id} keeps it` });
          continue;
        }
        byKey.set(key, { id, source: "extension" });
      }
    }
  return { byKey, dropped };
}

export function declaredKeybinding(
  state: ExtensionStateResult | null,
  id: string,
): ExtensionKeybindingState | undefined {
  const parsed = parseShortcutId(id);
  if (parsed?.kind !== "ext") return undefined;
  return state?.extensions
    .find((entry) => entry.id === parsed.ext)
    ?.contributions.keybindings.find((item) => item.command === parsed.command);
}

function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.matches(".xterm-helper-textarea")) return false;
  return (
    target.isContentEditable ||
    target.matches("input, textarea, select, [contenteditable='true']")
  );
}

/** What a key press targets: the focused pane of the active connection. */
function activeTarget() {
  const state = store.get();
  const paneId = state.selectedPaneId ?? state.layout?.focused_pane_id;
  const pane =
    state.panes.find((item) => item.pane_id === paneId) ??
    state.panes.find((item) => item.focused);
  const workspace =
    state.workspaces.find((item) => item.workspace_id === pane?.workspace_id) ??
    state.workspaces.find((item) => item.focused);
  const tab = state.tabs.find((item) => item.tab_id === pane?.tab_id);
  return { workspace, tab, pane };
}

export function runShortcutId(id: string) {
  const parsed = parseShortcutId(id);
  if (!parsed) return;
  const target = activeTarget();
  if (parsed.kind === "herdr") {
    void store.invokeHerdrPluginAction(
      parsed.plugin,
      parsed.action,
      pluginInvocationContext(target),
    );
    return;
  }
  const name =
    getExtensionsState()?.extensions.find((entry) => entry.id === parsed.ext)
      ?.name ?? parsed.ext;
  void runCommandNotify(
    {
      ext: parsed.ext,
      context: {
        connection_id: bridge.connection().connectionId,
        ...(target.workspace
          ? { workspace_id: target.workspace.workspace_id }
          : {}),
        ...(target.tab ? { tab_id: target.tab.tab_id } : {}),
        ...(target.pane ? { pane_id: target.pane.pane_id } : {}),
        ...(target.pane?.agent ? { agent: target.pane.agent } : {}),
      },
    },
    parsed.command,
    name,
  );
}

/** Handles one keydown; true when it ran a dynamic shortcut. */
export function dispatchDynamicShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || editableTarget(event.target)) return false;
  const key = shortcutFromEvent(event);
  if (!key) return false;
  const { platform, preset } = getShortcutSnapshot();
  const bound = effectiveBindings(getExtensionsState(), platform).byKey.get(
    key,
  );
  if (!bound) return false;
  // Extension defaults never take a key a core shortcut holds; the user's can.
  if (
    bound.source === "extension" &&
    SHORTCUT_IDS.some((id) => matchesShortcut(event, id, preset.bindings))
  )
    return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || document.querySelector(".modal-backdrop")) return true;
  runShortcutId(bound.id);
  return true;
}

let installed = false;
/** Idempotent; the listener stays for the page's life. */
export function installKeybindings() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", dispatchDynamicShortcut, {
    capture: true,
  });
}

/** Unit tests only. */
export function uninstallKeybindings() {
  window.removeEventListener("keydown", dispatchDynamicShortcut, {
    capture: true,
  });
  installed = false;
}
