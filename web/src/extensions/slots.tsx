import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ExtensionSlotContribution,
  type ExtensionStateEntry,
  matchesEvent,
} from "../../../shared/extensions";
import { bridge } from "../api";
import { useLayoutPreferences } from "../layoutPreferences";
import { useStoreSelector } from "../store";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import { ElementRenderer } from "./ElementRenderer";
import { ExtensionErrorBoundary } from "./ExtensionErrorBoundary";
import { useExtensionsState } from "./state";
import type { SlotTarget } from "./types";

export interface SlotItem {
  key: string;
  ext: string;
  extName: string;
  entryId: string;
  /** Title a manifest declares, for tabs and sections. */
  title?: string;
  /** Slot data, an element tree, or `{ error }` from the extension's render. */
  value: unknown;
}

const EMPTY: SlotItem[] = [];

function widthClass(width: number) {
  return width < 640 ? "compact" : width < 1024 ? "medium" : "wide";
}

/** The slot context CONTRACT §6 sends: connection scope, entities and viewer. */
export function useSlotContext(target: SlotTarget): Record<string, unknown> {
  const client = useConnectionClient();
  const { mobile } = useLayoutPreferences();
  const remote = useStoreSelector(
    (state) =>
      !!state.connections.find((item) => item.id === state.activeConnectionId)
        ?.ssh_destination,
  );
  const { workspace, tab, pane } = target;
  const workspaceId = workspace?.workspace_id ?? target.workspaceId;
  const tabId = tab?.tab_id ?? target.tabId;
  const paneId = pane?.pane_id ?? target.paneId;
  const agent = pane?.agent ?? target.agent;
  return useMemo(() => {
    const root = document.documentElement;
    return {
      connection_id: client.connectionId,
      generation: client.serverRuntimeGeneration,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(tabId ? { tab_id: tabId } : {}),
      ...(paneId ? { pane_id: paneId } : {}),
      ...(agent ? { agent } : {}),
      ...(workspace?.worktree?.checkout_path || workspace?.cwd
        ? { checkout_path: workspace.worktree?.checkout_path ?? workspace.cwd }
        : {}),
      remote,
      mobile,
      viewer: {
        mobile,
        theme: root.dataset.theme ?? "dark",
        accent: root.dataset.accent ?? "",
        width: widthClass(window.innerWidth),
      },
    };
  }, [
    client,
    mobile,
    remote,
    workspaceId,
    workspace?.cwd,
    workspace?.worktree?.checkout_path,
    tabId,
    paneId,
    agent,
  ]);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Slot data a manifest declares without a mod; the mod's render overrides it. */
export function manifestSlotData(
  slot: string,
  contribution: ExtensionSlotContribution,
  extName: string,
): unknown {
  const title = contribution.title ?? contribution.id;
  const command = contribution.command ?? contribution.id;
  if (slot.endsWith(".badge"))
    return {
      text: contribution.text,
      icon: contribution.icon,
      tone: contribution.tone ?? "neutral",
      tooltip: contribution.tooltip ?? title,
      command: contribution.command,
    };
  if (slot === "statusbar.item")
    return {
      text: contribution.text ?? title,
      tone: contribution.tone,
      icon: contribution.icon,
      tooltip: contribution.tooltip,
      command: contribution.command,
    };
  if (slot.startsWith("context-menu."))
    return {
      groups: [
        {
          label: extName,
          items: [
            {
              key: contribution.id,
              label: title,
              detail: contribution.detail,
              danger: contribution.danger,
              command,
            },
          ],
        },
      ],
    };
  if (
    slot === "menu.item" ||
    slot === "topbar.item" ||
    slot === "pane.toolbar" ||
    slot === "command"
  )
    return {
      title,
      detail: contribution.detail,
      icon: contribution.icon,
      command,
      danger: contribution.danger,
    };
  return undefined;
}

function isActive(entry: ExtensionStateEntry) {
  return entry.enabled && entry.status !== "safe_mode";
}

/**
 * The items one slot shows: manifest-declared data filtered by `when`, then the
 * mods' own `ext.ui.render` entries (which win), in extension order.
 */
export function useSlotItems(
  slot: string,
  target: SlotTarget = {},
): { items: SlotItem[]; loaded: boolean; context: Record<string, unknown> } {
  const client = useConnectionClient();
  const state = useExtensionsState();
  const context = useSlotContext(target);
  const contextKey = JSON.stringify(context);
  const scope = connectionClientScopeKey(client, slot, contextKey);
  const [rendered, setRendered] = useState<{
    scope: string;
    entries: Array<{ ext: string; entry_id: string; value: unknown }>;
  }>({ scope: "", entries: [] });
  const [refresh, setRefresh] = useState(0);
  const latest = useRef(0);
  const active = !!state && !state.safe_mode && state.extensions.some(isActive);

  useEffect(
    () =>
      bridge.onExtensions((push) => {
        if (!("invalidate" in push) || !push.invalidate) return;
        if (!push.invalidate.slot || push.invalidate.slot === slot)
          setRefresh((count) => count + 1);
      }),
    [slot],
  );

  useEffect(() => {
    if (!active) return;
    const request = ++latest.current;
    const current = () => request === latest.current && client.isCurrent();
    bridge
      .call(
        "ext.ui.render",
        { slot, context: JSON.parse(contextKey) },
        undefined,
        { lane: "background" },
      )
      .then(
        (result) => {
          if (!current()) return;
          const entries = Array.isArray(result?.entries) ? result.entries : [];
          setRendered({
            scope,
            entries: entries.filter(
              (entry: { ext?: unknown; entry_id?: unknown }) =>
                typeof entry?.ext === "string" &&
                typeof entry?.entry_id === "string",
            ),
          });
        },
        () => current() && setRendered({ scope, entries: [] }),
      );
  }, [active, client, slot, contextKey, scope, refresh, state]);

  const items = useMemo(() => {
    if (!state || state.safe_mode) return EMPTY;
    const names = new Map(state.extensions.map((e) => [e.id, e.name]));
    const order = new Map(state.extensions.map((e, i) => [e.id, i]));
    const found = new Map<string, SlotItem>();
    const put = (
      ext: string,
      entryId: string,
      value: unknown,
      title = found.get(`${ext}:${entryId}`)?.title,
    ) => {
      const key = `${ext}:${entryId}`;
      found.set(key, {
        key,
        ext,
        extName: names.get(ext) ?? ext,
        entryId,
        title,
        value,
      });
    };
    for (const entry of state.extensions) {
      if (!isActive(entry)) continue;
      for (const contribution of entry.contributions.slots) {
        if (contribution.slot !== slot) continue;
        if (!matchesEvent(contribution.when, context)) continue;
        put(
          entry.id,
          contribution.id,
          manifestSlotData(slot, contribution, entry.name),
          contribution.title,
        );
      }
      if (slot === "command")
        for (const command of entry.contributions.commands) {
          if (!matchesEvent(command.when, context)) continue;
          put(entry.id, `command:${command.id}`, {
            title: command.title,
            detail: command.detail,
            icon: command.icon,
            keywords: command.keywords,
            danger: command.danger,
            command: command.id,
          });
        }
    }
    if (rendered.scope === scope)
      for (const entry of rendered.entries)
        if (names.has(entry.ext)) put(entry.ext, entry.entry_id, entry.value);
    return [...found.values()].sort(
      (a, b) => (order.get(a.ext) ?? 0) - (order.get(b.ext) ?? 0),
    );
    // `context` is memoized on exactly what `scope` already encodes.
  }, [state, slot, rendered, scope, context]);

  return { items, loaded: rendered.scope === scope || !active, context };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asText(value: unknown): string | undefined {
  return str(value);
}

export function errorOf(value: unknown): string | undefined {
  return isRecord(value) && "error" in value
    ? String(value.error ?? "Render failed")
    : undefined;
}

/** Element-tree entries of one slot, each in its own error boundary. */
export function SlotHost({
  slot,
  items,
  context,
}: {
  slot: string;
  items: SlotItem[];
  context: Record<string, unknown>;
}) {
  return (
    <>
      {items.map((item) => {
        const error = errorOf(item.value);
        return (
          <section
            key={item.key}
            className="ext-entry"
            data-extension={item.ext}
            aria-label={item.extName}
          >
            <ExtensionErrorBoundary ext={item.extName}>
              {item.value === undefined ? (
                <span
                  className="ext-spinner"
                  role="status"
                  aria-label="Loading"
                />
              ) : error !== undefined ? (
                <p className="ext-error" role="alert">
                  {item.extName}: {error}
                </p>
              ) : (
                <ElementRenderer
                  tree={item.value}
                  ctx={{
                    ext: item.ext,
                    slot,
                    entryId: item.entryId,
                    context,
                  }}
                />
              )}
            </ExtensionErrorBoundary>
          </section>
        );
      })}
    </>
  );
}
