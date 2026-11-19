import type {
  ExtensionKeybinding,
  ExtensionKeybindingConflict,
  ExtensionKeybindingState,
} from "../../../shared/extensions";
import {
  builtinCollidesWithGlobal,
  builtinShortcutBindings,
  normalizeShortcut,
  SHORTCUT_PLATFORM_IDS,
  type ShortcutPlatform,
} from "../../../shared/shortcuts";

/** A manifest key (`mod+shift+r`) in the web app's form on each platform, or null. */
export function keybindingKeys(
  key: string,
): Record<ShortcutPlatform, string> | null {
  const keys: Partial<Record<ShortcutPlatform, string>> = {};
  for (const platform of SHORTCUT_PLATFORM_IDS) {
    const normalized = normalizeShortcut(key, platform);
    if (!normalized) return null;
    keys[platform] = normalized;
  }
  return keys as Record<ShortcutPlatform, string>;
}

/** Why `key` cannot be a global command shortcut, or null when it can. */
export function keybindingKeyError(key: string): string | null {
  const keys = keybindingKeys(key);
  if (!keys)
    return `expected a key combination such as "mod+shift+r" (got ${JSON.stringify(key)})`;
  // The web app's rules for global shortcuts, so users can rebind them too.
  for (const normalized of Object.values(keys)) {
    if (normalized.endsWith("Click"))
      return "keybindings use keyboard keys, not clicks";
    if (
      !/^(Ctrl|Alt|Meta)\+/.test(normalized) &&
      !/^(Shift\+)?(F\d+|PageUp|PageDown|Home|End|Insert|Delete|Enter|Backspace|Arrow\w+)$/.test(
        normalized,
      )
    )
      return "add ctrl, alt or mod to printable keys so typing remains available";
    if (!normalized.includes("+") && !/^F\d+$/.test(normalized))
      return "keybindings need a modifier or a function key";
  }
  return null;
}

type KeyOwner = Pick<ExtensionKeybindingConflict, "winner" | "kind">;

/**
 * Resolves keybinding conflicts across extensions in run order. Built-in
 * defaults come first, then each extension's bindings in manifest order; a
 * later binding for a taken key loses on that platform and records who kept
 * it. Inactive extensions see their conflicts but take no keys. User
 * bindings override all of these in the browser.
 */
export function resolveKeybindings(
  extensions: ReadonlyArray<{
    id: string;
    keybindings: readonly ExtensionKeybinding[];
    active?: boolean;
  }>,
): Map<string, ExtensionKeybindingState[]> {
  const taken = new Map<ShortcutPlatform, Map<string, KeyOwner>>();
  for (const platform of SHORTCUT_PLATFORM_IDS) {
    const keys = new Map<string, KeyOwner>();
    for (const [id, bound] of Object.entries(builtinShortcutBindings(platform)))
      if (builtinCollidesWithGlobal(id))
        for (const key of bound)
          if (!keys.has(key)) keys.set(key, { winner: id, kind: "builtin" });
    taken.set(platform, keys);
  }
  const resolved = new Map<string, ExtensionKeybindingState[]>();
  for (const { id, keybindings, active = true } of extensions) {
    resolved.set(
      id,
      keybindings.flatMap((binding) => {
        const keys = keybindingKeys(binding.key);
        if (!keys) return [];
        const conflicts: ExtensionKeybindingConflict[] = [];
        for (const platform of SHORTCUT_PLATFORM_IDS) {
          const owners = taken.get(platform)!;
          const key = keys[platform];
          const owner = owners.get(key);
          if (owner) conflicts.push({ platform, key, ...owner });
          else if (active)
            owners.set(key, {
              winner: `ext:${id}:${binding.command}`,
              kind: "extension",
            });
        }
        return [{ ...binding, keys, conflicts }];
      }),
    );
  }
  return resolved;
}
