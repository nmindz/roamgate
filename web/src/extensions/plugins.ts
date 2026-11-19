import { useEffect, useState } from "react";
import { bridge, type ConnectionClient } from "../api";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import type { SlotTarget } from "./types";

// Herdr's own plugin actions (`plugin.action.list` / `plugin.action.invoke`),
// shown in the palette and bindable to keys like extension commands.

export interface PluginAction {
  plugin_id: string;
  action_id: string;
  title: string;
  description?: string;
  contexts: string[];
}

const cache = new Map<string, Promise<PluginAction[]>>();
const listeners = new Set<() => void>();

function parseActions(result: unknown): PluginAction[] {
  const actions = (result as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((item: Record<string, unknown>) =>
    typeof item?.plugin_id === "string" &&
    typeof item.action_id === "string" &&
    typeof item.title === "string"
      ? [
          {
            plugin_id: item.plugin_id,
            action_id: item.action_id,
            title: item.title,
            description:
              typeof item.description === "string"
                ? item.description
                : undefined,
            contexts: Array.isArray(item.contexts)
              ? item.contexts.map(String)
              : [],
          },
        ]
      : [],
  );
}

/** One fetch per connection generation; only a successful answer is kept. */
export function loadPluginActions(
  client: ConnectionClient,
): Promise<PluginAction[]> {
  const key = connectionClientScopeKey(client, client.serverRuntimeGeneration);
  const hit = cache.get(key);
  if (hit) return hit;
  for (const stale of cache.keys())
    if (stale.startsWith(`["${client.connectionId}",`)) cache.delete(stale);
  const pending = client
    .call("plugin.action.list", {}, undefined, { lane: "background" })
    .then(parseActions);
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

export function resetPluginActions() {
  cache.clear();
  listeners.forEach((listener) => listener());
}

let watching = false;
function watchPluginEvents() {
  if (watching) return;
  watching = true;
  // Plugins installed or removed while Roamgate runs show up without a reload.
  bridge.onEvent((message) => {
    if (
      typeof message.event === "string" &&
      message.event.startsWith("plugin_")
    )
      resetPluginActions();
  });
}

/** The active connection's plugin actions; empty until loaded or when unsupported. */
export function usePluginActions(enabled = true): PluginAction[] {
  const client = useConnectionClient();
  const [actions, setActions] = useState<PluginAction[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    watchPluginEvents();
    const bump = () => setVersion((count) => count + 1);
    listeners.add(bump);
    return () => void listeners.delete(bump);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    loadPluginActions(client).then(
      (list) => current && client.isCurrent() && setActions(list),
      () => current && setActions([]),
    );
    return () => {
      current = false;
    };
  }, [client, enabled, version]);
  return actions;
}

/** The `context` Herdr's plugin API takes, from what a slot or the keyboard targets. */
export function pluginInvocationContext(
  target: SlotTarget,
): Record<string, unknown> {
  const { workspace, tab, pane } = target;
  const set = (key: string, value: unknown) =>
    value === undefined || value === null || value === ""
      ? {}
      : { [key]: value };
  return {
    ...set("workspace_id", workspace?.workspace_id ?? pane?.workspace_id),
    ...set("workspace_label", workspace?.label),
    ...set(
      "workspace_cwd",
      workspace?.worktree?.checkout_path ?? workspace?.cwd,
    ),
    ...set("tab_id", tab?.tab_id ?? pane?.tab_id),
    ...set("tab_label", tab?.label),
    ...set("focused_pane_id", pane?.pane_id),
    ...set("focused_pane_cwd", pane?.foreground_cwd ?? pane?.cwd),
    ...set("focused_pane_agent", pane?.agent),
    invocation_source: "roamgate",
  };
}
