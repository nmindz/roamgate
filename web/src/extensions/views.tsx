import { useEffect, useState } from "react";
import { CommandGroup, CommandItem } from "../components/ui/command";
import { CloseButton } from "../components/CloseButton";
import { Toast } from "../components/Toast";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { bridge } from "../api";
import {
  ApprovalCard,
  PaneApprovals,
  useExtensionNames,
  usePendingApprovals,
} from "./approvals";
import { ExtIcon } from "./icons";
import { composerCommandsFromState } from "./contributions";
import { useExtensionsState } from "./state";
import { herdrShortcutId } from "./dynamicShortcuts";
import { pluginInvocationContext, usePluginActions } from "./plugins";
import { runCommandNotify } from "./run";
import { store } from "../store";
import {
  asText,
  isRecord,
  errorOf,
  SlotHost,
  type SlotItem,
  useSlotItems,
} from "./slots";
import { enqueueToast, type QueuedToast } from "./toasts";
import type { ComposerItem, HostProps, SlotTarget } from "./types";

type Context = Record<string, unknown>;

interface ItemData {
  title: string;
  detail?: string;
  icon?: string;
  command: string;
  danger?: boolean;
  disabledReason?: string;
  count?: number;
  keywords: string[];
}

/** Reads CommandSlotData (palette, menu, topbar, pane toolbar) tolerantly. */
export function itemData(value: unknown): ItemData | null {
  if (!isRecord(value) || errorOf(value) !== undefined) return null;
  const title = asText(value.title);
  const command = asText(value.command);
  if (!title || !command) return null;
  return {
    title,
    command,
    detail: asText(value.detail),
    icon: asText(value.icon),
    danger: value.danger === true,
    disabledReason: asText(value.disabled_reason),
    count: typeof value.count === "number" ? value.count : undefined,
    keywords: Array.isArray(value.keywords) ? value.keywords.map(String) : [],
  };
}

function useRun(context: Context, onRun?: () => void) {
  return (item: SlotItem, command: string) =>
    void runCommandNotify(
      { ext: item.ext, context },
      command,
      item.extName,
    ).then(() => onRun?.());
}

/** An entry's accessible name, prefixed with its extension unless it names it already. */
function entryLabel(extName: string, text: string): string {
  return text.toLowerCase().includes(extName.toLowerCase())
    ? text
    : `${extName}: ${text}`;
}

function rows(items: SlotItem[]) {
  return items.flatMap((item) => {
    const data = itemData(item.value);
    return data ? [{ item, data }] : [];
  });
}

export function ApprovalsInbox() {
  const list = usePendingApprovals();
  const names = useExtensionNames();
  if (list.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="topbar-button icon-button ext-approvals-button"
          aria-label={`Approvals, ${list.length} pending`}
          title="Pending extension approvals"
        >
          <ExtIcon name="shield-check" size={15} />
          <span className="ext-count">{list.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="ext-approvals-popover">
        {list.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            extName={names.get(approval.ext) ?? approval.ext}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function TopbarView({ onRun }: HostProps) {
  const { items, context } = useSlotItems("topbar.item");
  const run = useRun(context, onRun);
  return (
    <>
      <ApprovalsInbox />
      {rows(items).map(({ item, data }) => (
        <button
          key={item.key}
          type="button"
          className={`topbar-button icon-button ext-topbar-item${data.danger ? " is-danger" : ""}`}
          title={entryLabel(item.extName, data.title)}
          aria-label={entryLabel(item.extName, data.title)}
          disabled={!!data.disabledReason}
          onClick={() => run(item, data.command)}
        >
          <ExtIcon name={data.icon} size={15} />
          {data.count ? <span className="ext-count">{data.count}</span> : null}
          <span className="mobile-nav-label ext-topbar-label">
            {data.title}
          </span>
        </button>
      ))}
    </>
  );
}

export function MenuItemsView({ onRun }: HostProps) {
  const { items, context } = useSlotItems("menu.item");
  const run = useRun(context, onRun);
  const list = rows(items);
  if (list.length === 0) return null;
  return (
    <div className="config-section">
      {list.map(({ item, data }) => (
        <button
          key={item.key}
          type="button"
          className="config-menu-item"
          disabled={!!data.disabledReason}
          title={data.disabledReason}
          onClick={() => run(item, data.command)}
        >
          <span className="config-item-icon">
            <ExtIcon name={data.icon} size={15} />
          </span>
          <span className="config-item-copy">
            <strong>{data.title}</strong>
            <span>{data.detail ?? item.extName}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function SidebarSectionView() {
  const { items, context } = useSlotItems("sidebar.section");
  return (
    <>
      {items.map((item) => (
        <section
          key={item.key}
          className="ext-sidebar-section"
          aria-label={item.extName}
        >
          <h3 className="config-title">{item.extName}</h3>
          <SlotHost slot="sidebar.section" items={[item]} context={context} />
        </section>
      ))}
    </>
  );
}

interface StatusData {
  text: string;
  tone: string;
  icon?: string;
  tooltip?: string;
  command?: string;
}

function statusData(value: unknown): StatusData | null {
  if (!isRecord(value) || errorOf(value) !== undefined) return null;
  const text = asText(value.text);
  if (!text) return null;
  return {
    text,
    tone: asText(value.tone) ?? "neutral",
    icon: asText(value.icon),
    tooltip: asText(value.tooltip),
    command: asText(value.command),
  };
}

/** Bottom bar of the desktop layout; absent when no item is visible. */
export function StatusBarView() {
  const { items, context } = useSlotItems("statusbar.item");
  const run = useRun(context);
  // Mobile has no status bar; its items show in the topbar stack instead.
  if (context.mobile) return null;
  const list = items.flatMap((item) => {
    const data = statusData(item.value);
    return data ? [{ item, data }] : [];
  });
  if (list.length === 0) return null;
  return (
    <footer className="ext-statusbar" aria-label="Extension status">
      {list.map(({ item, data }) => {
        const body = (
          <>
            {data.icon ? <ExtIcon name={data.icon} size={12} /> : null}
            {data.text}
          </>
        );
        const title = `${item.extName}${data.tooltip ? `: ${data.tooltip}` : ""}`;
        return data.command ? (
          <button
            key={item.key}
            type="button"
            className={`ext-status-item ext-tone-${data.tone}`}
            title={title}
            onClick={() => run(item, data.command!)}
          >
            {body}
          </button>
        ) : (
          <span
            key={item.key}
            className={`ext-status-item ext-tone-${data.tone}`}
            title={title}
          >
            {body}
          </span>
        );
      })}
    </footer>
  );
}

const MAX_BADGES_PER_EXTENSION = 2;

export function BadgesView({ slot, ...target }: HostProps) {
  const { items, context } = useSlotItems(slot, target);
  const run = useRun(context);
  const perExt = new Map<string, number>();
  const shown = items.filter((item) => {
    const count = perExt.get(item.ext) ?? 0;
    perExt.set(item.ext, count + 1);
    return count < MAX_BADGES_PER_EXTENSION && isRecord(item.value);
  });
  if (shown.length === 0) return null;
  return (
    <span className="ext-badges">
      {shown.map((item) => {
        const value = item.value as Record<string, unknown>;
        if (errorOf(value) !== undefined) return null;
        const text = asText(value.text);
        const tooltip = asText(value.tooltip) ?? text ?? item.extName;
        const command = asText(value.command);
        const className = `badge ext-badge ext-tone-${asText(value.tone) ?? "neutral"}`;
        const body = (
          <>
            {asText(value.icon) ? (
              <ExtIcon name={asText(value.icon)} size={11} />
            ) : null}
            {text}
          </>
        );
        const title = entryLabel(item.extName, tooltip);
        return command ? (
          <button
            key={item.key}
            type="button"
            className={className}
            title={title}
            aria-label={title}
            onClick={(event) => {
              event.stopPropagation();
              run(item, command);
            }}
          >
            {body}
          </button>
        ) : (
          <span
            key={item.key}
            className={className}
            title={title}
            aria-label={title}
          >
            {body}
          </span>
        );
      })}
    </span>
  );
}

interface MenuGroup {
  label: string;
  items: Array<{
    key: string;
    label: string;
    detail?: string;
    danger?: boolean;
    disabledReason?: string;
    command: string;
  }>;
}

function menuGroups(value: unknown): MenuGroup[] {
  if (!isRecord(value) || !Array.isArray(value.groups)) return [];
  return value.groups.flatMap((group): MenuGroup[] => {
    if (!isRecord(group) || !Array.isArray(group.items)) return [];
    const entries = group.items.flatMap((item) => {
      if (!isRecord(item)) return [];
      const label = asText(item.label);
      const command = asText(item.command);
      if (!label || !command) return [];
      return [
        {
          key: asText(item.key) ?? label,
          label,
          detail: asText(item.detail),
          danger: item.danger === true,
          disabledReason: asText(item.disabled_reason),
          command,
        },
      ];
    });
    return entries.length
      ? [{ label: asText(group.label) ?? "", items: entries }]
      : [];
  });
}

/**
 * Extension groups of a context menu. Keys are positional, so two extensions
 * (or an extension and the core) with the same label or key never collide.
 */
export function ContextMenuView({ slot, onRun, ...target }: HostProps) {
  const { items, context } = useSlotItems(slot, target);
  const run = useRun(context, onRun);
  return (
    <>
      {items.flatMap((item) =>
        menuGroups(item.value).map((group, groupIndex) => (
          <div
            key={`${item.key}#${groupIndex}`}
            className="context-menu-group ext-menu-group"
          >
            <div className="context-menu-group-title">
              {item.extName}
              {group.label && group.label !== item.extName
                ? ` · ${group.label}`
                : ""}
            </div>
            {group.items.map((entry, entryIndex) => (
              <button
                key={`${entryIndex}:${entry.key}`}
                type="button"
                className={`context-menu-item${entry.danger ? " is-danger" : ""}`}
                disabled={!!entry.disabledReason}
                title={entry.disabledReason ?? entry.detail}
                onClick={() => run(item, entry.command)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )),
      )}
    </>
  );
}

export function PaneToolbarView(props: HostProps) {
  const { items, context } = useSlotItems("pane.toolbar", props);
  const run = useRun(context);
  return (
    <>
      {rows(items).map(({ item, data }) => (
        <button
          key={item.key}
          type="button"
          className={`terminal-pane-action${data.danger ? " is-danger" : ""}`}
          title={entryLabel(item.extName, data.title)}
          aria-label={entryLabel(item.extName, data.title)}
          disabled={!!data.disabledReason}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => run(item, data.command)}
        >
          <ExtIcon name={data.icon} />
        </button>
      ))}
    </>
  );
}

export function PaneOverlayView(props: HostProps) {
  const { items, context } = useSlotItems("pane.overlay", props);
  const connectionId = asText(context.connection_id);
  return (
    <div className="ext-pane-overlay">
      {props.pane ? (
        <PaneApprovals
          paneId={props.pane.pane_id}
          connectionId={connectionId}
        />
      ) : null}
      <SlotHost slot="pane.overlay" items={items} context={context} />
    </div>
  );
}

export function ComposerView({ onItems, ...target }: HostProps) {
  const { items } = useSlotItems("composer.command", target);
  const state = useExtensionsState();
  const agent = target.agent ?? target.pane?.agent;
  useEffect(() => {
    const rendered: ComposerItem[] = items.flatMap((item) => {
      if (!isRecord(item.value) || errorOf(item.value) !== undefined) return [];
      const name = asText(item.value.name);
      if (!name) return [];
      const agents = item.value.agents;
      if (Array.isArray(agents) && agent && !agents.includes(agent)) return [];
      return [
        {
          name,
          description: asText(item.value.description) ?? item.extName,
          arguments: asText(item.value.arguments),
          expand: asText(item.value.expand),
        },
      ];
    });
    // A mod's render of the same name replaces the manifest's entry.
    const names = new Set(rendered.map((item) => item.name));
    onItems?.([
      ...composerCommandsFromState(state, agent).filter(
        (item) => !names.has(item.name),
      ),
      ...rendered,
    ]);
    return () => onItems?.([]);
  }, [items, onItems, agent, state]);
  return null;
}

/** Herdr plugin actions of the active connection, run with the palette's target. */
function PluginActionsGroup({
  query,
  target,
  onRun,
}: {
  query: string;
  target: SlotTarget;
  onRun?: () => void;
}) {
  const actions = usePluginActions();
  const shown = actions.filter((action) =>
    `${action.plugin_id} ${action.title} ${action.description ?? ""}`
      .toLowerCase()
      .includes(query),
  );
  if (shown.length === 0) return null;
  return (
    <CommandGroup heading="Herdr plugins">
      {shown.map((action) => (
        <CommandItem
          key={herdrShortcutId(action.plugin_id, action.action_id)}
          value={`herdr ${action.plugin_id} ${action.action_id} ${action.title}`}
          onSelect={() => {
            void store.invokeHerdrPluginAction(
              action.plugin_id,
              action.action_id,
              pluginInvocationContext(target),
            );
            onRun?.();
          }}
        >
          <span className="command-item-icon">
            <ExtIcon name="plug" size={15} />
          </span>
          <span className="command-item-text">
            <span className="command-item-title">
              {action.plugin_id}: {action.title}
            </span>
            {action.description ? (
              <span className="command-item-detail">{action.description}</span>
            ) : null}
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Palette group per extension; the palette's search text filters it. */
export function PaletteView({ search = "", onRun, ...target }: HostProps) {
  const { items, context } = useSlotItems("command", target);
  const run = useRun(context, onRun);
  const query = search.trim().toLowerCase();
  const seen = new Set<string>();
  const groups = new Map<string, Array<{ item: SlotItem; data: ItemData }>>();
  for (const { item, data } of rows(items)) {
    const id = `${item.ext}:${data.command}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const haystack = [data.title, data.detail, item.extName, ...data.keywords]
      .join(" ")
      .toLowerCase();
    if (query && !haystack.includes(query)) continue;
    groups.set(item.extName, [
      ...(groups.get(item.extName) ?? []),
      { item, data },
    ]);
  }
  return (
    <>
      {[...groups].map(([name, list]) => (
        <CommandGroup key={name} heading={name}>
          {list.map(({ item, data }) => (
            <CommandItem
              key={item.key}
              value={`ext ${item.key} ${data.title}`}
              keywords={data.keywords}
              disabled={!!data.disabledReason}
              title={data.disabledReason}
              className={data.danger ? "is-danger" : undefined}
              onSelect={() => run(item, data.command)}
            >
              <span className="command-item-icon">
                <ExtIcon name={data.icon} size={15} />
              </span>
              <span className="command-item-text">
                <span className="command-item-title">{data.title}</span>
                {data.disabledReason || data.detail ? (
                  <span className="command-item-detail">
                    {data.disabledReason ?? data.detail}
                  </span>
                ) : null}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
      <PluginActionsGroup query={query} target={target} onRun={onRun} />
    </>
  );
}

const TOAST_MS = 8_000;
let toastId = 0;

/** Extension toasts: their own stack of at most five, apart from core notices. */
export function ExtensionToasts() {
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  useEffect(() => {
    const timers = new Set<number>();
    const off = bridge.onExtensions((push) => {
      if (!("toast" in push) || typeof push.toast?.message !== "string") return;
      const toast: QueuedToast = { ...push.toast, id: ++toastId };
      setQueue((current) => enqueueToast(current, toast));
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setQueue((current) => current.filter((t) => t.id !== toast.id));
      }, TOAST_MS);
      timers.add(timer);
    });
    return () => {
      off();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);
  const drop = (id: number) =>
    setQueue((current) => current.filter((t) => t.id !== id));
  if (queue.length === 0) return null;
  return (
    <div className="ext-toasts" aria-live="polite">
      {queue.map((toast) => (
        <Toast
          key={toast.id}
          className={`toast toast-${toast.kind === "warning" ? "info" : toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
          notificationKey={toast.id}
          onDismiss={() => drop(toast.id)}
        >
          <span className="toast-mark" aria-hidden="true">
            <ExtIcon
              name={toast.kind === "error" ? "circle-alert" : "info"}
              size={16}
            />
          </span>
          <div className="toast-content">
            <strong>{toast.message}</strong>
            {toast.detail ? <p>{toast.detail}</p> : null}
          </div>
          <CloseButton
            variant="toast"
            label="Dismiss notification"
            onClick={() => drop(toast.id)}
          />
        </Toast>
      ))}
    </div>
  );
}

function useInspectorEntries(target: HostProps) {
  const panels = useSlotItems("inspector.panel", target);
  const surfaces = useSlotItems("workspace.surface", target);
  return {
    entries: [
      ...panels.items.map((item) => ({ item, slot: "inspector.panel" })),
      ...surfaces.items.map((item) => ({ item, slot: "workspace.surface" })),
    ],
    loaded: panels.loaded && surfaces.loaded,
    context: panels.context,
  };
}

export const extensionViewId = (item: SlotItem) =>
  `ext:${item.ext}:${item.entryId}`;

/** Extra Inspector tabs; they join the tab order with Tab, not the arrow keys. */
export function InspectorTabsView({ view, onSelect, ...target }: HostProps) {
  const { entries } = useInspectorEntries(target);
  return (
    <>
      {entries.map(({ item }) => {
        const id = extensionViewId(item);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            className={view === id ? "is-active" : ""}
            title={`${item.extName}: ${item.title ?? item.entryId}`}
            onClick={() => onSelect?.(id)}
          >
            <ExtIcon name="plug" size={14} /> {item.title ?? item.entryId}
          </button>
        );
      })}
    </>
  );
}

/** The body of an extension Inspector tab; a missing one asks to fall back. */
export function InspectorPanelView({ view, onMissing, ...target }: HostProps) {
  const { entries, loaded, context } = useInspectorEntries(target);
  const found = entries.find(({ item }) => extensionViewId(item) === view);
  useEffect(() => {
    if (loaded && !found) onMissing?.();
  }, [loaded, found, onMissing]);
  if (!found) return null;
  return (
    <div className="ext-inspector-panel">
      <h3 className="config-title">{found.item.extName}</h3>
      <SlotHost slot={found.slot} items={[found.item]} context={context} />
    </div>
  );
}
