import { useEffect, useState, useSyncExternalStore } from "react";
import { formatShortcut, shortcutFromEvent } from "../shortcutBindings";
import { useShortcutPreferences } from "../shortcutPreferences";
import {
  declaredKeybinding,
  effectiveBindings,
  extensionShortcutId,
  herdrShortcutId,
  readUserBindings,
  resetUserBinding,
  setUserBinding,
  subscribeDynamicShortcuts,
} from "./dynamicShortcuts";
import { usePluginActions } from "./plugins";
import { useExtensionsState } from "./state";

interface Row {
  id: string;
  group: string;
  label: string;
}

/** Keys for extension commands and Herdr plugin actions, in Keyboard shortcuts. */
export function ShortcutSettings() {
  const { platform } = useShortcutPreferences();
  const state = useExtensionsState();
  const actions = usePluginActions();
  const user = useSyncExternalStore(subscribeDynamicShortcuts, () =>
    JSON.stringify(readUserBindings()),
  );
  const bindings = JSON.parse(user) as Record<string, string[]>;
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState("");
  const effective = effectiveBindings(state, platform, bindings);

  const rows: Row[] = [
    ...(state && !state.safe_mode
      ? state.extensions.flatMap((entry) =>
          entry.enabled
            ? entry.contributions.commands.map((command) => ({
                id: extensionShortcutId(entry.id, command.id),
                group: entry.name,
                label: command.title,
              }))
            : [],
        )
      : []),
    ...actions.map((action) => ({
      id: herdrShortcutId(action.plugin_id, action.action_id),
      group: `Herdr plugin ${action.plugin_id}`,
      label: action.title,
    })),
  ];

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return setRecording(null);
      const key = shortcutFromEvent(event);
      if (!key) return;
      try {
        setUserBinding(recording, [key]);
        setError("");
        setRecording(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording]);

  if (rows.length === 0) return null;
  const keysOf = (id: string) =>
    [...effective.byKey]
      .filter(([, bound]) => bound.id === id)
      .map(([key]) => key);
  const format = (keys: string[]) =>
    keys.map((key) => formatShortcut(key, platform)).join(" / ") ||
    "Unassigned";

  return (
    <section
      className="ext-shortcuts"
      aria-label="Extension and plugin shortcuts"
    >
      <h3>Extensions and Herdr plugins</h3>
      {error ? (
        <p className="ext-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="ext-rows">
        {rows.map((row) => {
          const keys = keysOf(row.id);
          const dropped = effective.dropped.find((item) => item.id === row.id);
          const declared = declaredKeybinding(state, row.id);
          const overridden = row.id in bindings;
          return (
            <li key={row.id} className="ext-shortcut-row">
              <span className="ext-shortcut-label">
                <strong>{row.label}</strong>
                <span className="muted">{row.group}</span>
                {dropped ? (
                  <span className="ext-warning">
                    Not bound: {dropped.reason}{" "}
                    {formatShortcut(dropped.key, platform)}.
                  </span>
                ) : null}
                {overridden && declared ? (
                  <span className="muted">
                    Replaces the extension's default.
                  </span>
                ) : null}
              </span>
              <kbd>{format(keys)}</kbd>
              <button
                type="button"
                aria-label={`Change shortcut for ${row.label}`}
                onClick={() => {
                  setError("");
                  setRecording(recording === row.id ? null : row.id);
                }}
              >
                {recording === row.id ? "Press keys..." : "Change"}
              </button>
              {overridden ? (
                <button
                  type="button"
                  aria-label={`Reset shortcut for ${row.label}`}
                  onClick={() => resetUserBinding(row.id)}
                >
                  Reset
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
