import { herdrEventName } from "../utils/herdr-events";
import type { EventInput } from "./events";

/** Agent status as extensions see it: Herdr's values, normalized. */
export type AgentStatus = "working" | "blocked" | "done" | "idle";

export function normalizeAgentStatus(value: unknown): AgentStatus | null {
  if (typeof value !== "string") return null;
  const status = value.toLowerCase();
  if (status === "working" || status === "running" || status === "busy")
    return "working";
  if (status === "blocked" || status === "waiting" || status === "needs_input")
    return "blocked";
  if (status === "done" || status === "finished" || status === "completed")
    return "done";
  if (status === "idle") return "idle";
  return null;
}

interface PaneStatus {
  workspace_id?: string;
  tab_id?: string;
  agent?: string;
  status: AgentStatus;
}

function paneStatus(value: unknown): (PaneStatus & { pane_id: string }) | null {
  if (!value || typeof value !== "object") return null;
  const pane = value as Record<string, unknown>;
  const status = normalizeAgentStatus(pane.agent_status);
  if (typeof pane.pane_id !== "string" || !pane.pane_id || !status) return null;
  return {
    pane_id: pane.pane_id,
    status,
    workspace_id:
      typeof pane.workspace_id === "string" ? pane.workspace_id : undefined,
    tab_id: typeof pane.tab_id === "string" ? pane.tab_id : undefined,
    agent: typeof pane.agent === "string" ? pane.agent : undefined,
  };
}

/**
 * Raises `agent.status` once per transition of a pane's agent. The first
 * status seen for a pane only seeds it, so reconnects and pane lists never
 * replay old transitions.
 */
export function createAgentStatusEvents(args: {
  emit: (event: EventInput) => void;
  connection: () => { id: string; generation: number };
}) {
  const panes = new Map<string, PaneStatus>();
  let stopped = false;

  function observe(next: PaneStatus & { pane_id: string }) {
    const previous = panes.get(next.pane_id);
    const merged: PaneStatus = {
      workspace_id: next.workspace_id ?? previous?.workspace_id,
      tab_id: next.tab_id ?? previous?.tab_id,
      agent: next.agent ?? previous?.agent,
      status: next.status,
    };
    panes.set(next.pane_id, merged);
    if (!previous || previous.status === next.status) return;
    args.emit({
      name: "agent.status",
      connection: args.connection(),
      workspace_id: merged.workspace_id,
      tab_id: merged.tab_id,
      pane_id: next.pane_id,
      agent: merged.agent,
      from: previous.status,
      to: next.status,
    });
  }

  return {
    reconcilePaneList(result: unknown) {
      if (stopped) return;
      const listed = (result as { panes?: unknown } | null)?.panes;
      if (!Array.isArray(listed)) return;
      const live = new Set<string>();
      for (const value of listed) {
        const pane = paneStatus(value);
        if (!pane) continue;
        live.add(pane.pane_id);
        observe(pane);
      }
      for (const id of panes.keys()) if (!live.has(id)) panes.delete(id);
    },
    handleHerdrEvent(event: unknown) {
      if (stopped) return;
      const name = herdrEventName(event)?.replaceAll("_", ".");
      const data = (event as { data?: Record<string, unknown> } | null)?.data;
      if (!data || typeof data !== "object") return;
      if (name === "pane.agent.status.changed") {
        const pane = paneStatus(data);
        if (pane) observe(pane);
      } else if (name === "pane.closed" || name === "pane.exited") {
        panes.delete(String(data.pane_id));
      } else if (name === "workspace.closed" || name === "tab.closed") {
        for (const [id, pane] of panes) {
          if (
            name === "workspace.closed"
              ? pane.workspace_id === data.workspace_id
              : pane.tab_id === data.tab_id
          )
            panes.delete(id);
        }
      }
    },
    stop() {
      stopped = true;
      panes.clear();
    },
  };
}

export type AgentStatusEvents = ReturnType<typeof createAgentStatusEvents>;

/** The `herdr.event` payload: Herdr's own event name and data. */
export function herdrExtensionEvent(
  event: unknown,
  connection: { id: string; generation: number },
): EventInput | null {
  const name = herdrEventName(event);
  if (!name) return null;
  const data = (event as { data?: unknown }).data;
  const fields =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return {
    name: "herdr.event",
    connection,
    event: name,
    data: data ?? null,
    workspace_id:
      typeof fields.workspace_id === "string" ? fields.workspace_id : undefined,
    tab_id: typeof fields.tab_id === "string" ? fields.tab_id : undefined,
    pane_id: typeof fields.pane_id === "string" ? fields.pane_id : undefined,
  };
}
