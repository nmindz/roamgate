// Reference gates. Handlers answer with a Gate: allow, deny with a reason,
// or ask a person. Every origin (browser, Ranger, tasks) passes through them.
import type { On } from "roamgate";

function list(value: unknown, key: string): Array<Record<string, unknown>> {
  const items =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : value;
  return Array.isArray(items) ? items : [];
}

export function register(on: On) {
  // Closing a pane whose agent is mid-turn throws its work away.
  on("pane.close", {}, async ($, event) => {
    const agents = list(
      await $.roamgate.agents(event.connection?.id),
      "agents",
    );
    const busy = agents.find(
      (agent) => agent.pane_id === event.pane_id && agent.status === "working",
    );
    if (!busy) return { decision: "allow" };
    return {
      decision: "deny",
      reason: `${String(busy.agent ?? "the agent")} is still working`,
    };
  });

  // Text for a protected workspace waits for a person.
  on("terminal.submit", {}, async ($, event) => {
    const pattern = await $.config.get("protected_pattern");
    if (typeof pattern !== "string" || !pattern) return { decision: "allow" };
    const workspaces = list(
      await $.roamgate.workspaces(event.connection?.id),
      "workspaces",
    );
    const target = workspaces.find(
      (workspace) => workspace.workspace_id === event.workspace_id,
    );
    const label = String(target?.label ?? target?.name ?? "");
    if (!new RegExp(pattern).test(label)) return { decision: "allow" };
    return {
      decision: "ask",
      title: `Send to ${label}?`,
      body: String(event.text ?? "").slice(0, 500),
      risk: "high",
      timeout_ms: 5 * 60_000,
    };
  });

  // Fail closed: if this check throws, removing the worktree is blocked.
  on(
    "worktree.remove",
    {},
    (_$, event) => {
      if (event.force === true) throw new Error("refusing a forced removal");
      return { decision: "allow" };
    },
    { onFailure: "block" },
  );
}
