import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ActionEventName,
  EventOrigin,
  ExtensionEventBase,
} from "../../../shared/extensions";
import { resolveAsk } from "./approvals";
import type { EventInput, ExtensionBus } from "./events";
import { GuardError, parseGate } from "./guard";

/**
 * Action events are raised at one choke point per mutation family, so the
 * browser, Ranger, scheduled tasks and extensions all pass the same gates.
 * Who asked is carried as an async-local origin set at each entry point.
 */

const originStore = new AsyncLocalStorage<EventOrigin>();

/** Runs `fn` with `origin` as the origin of every action it performs. */
export function runWithOrigin<T>(origin: EventOrigin, fn: () => T): T {
  return originStore.run(origin, fn);
}

/** The origin of the current call; paths outside every entry are browser HTTP routes. */
export function currentOrigin(): EventOrigin {
  return originStore.getStore() ?? "browser";
}

let installedBus: ExtensionBus | null = null;

/** The bus the bridge gates its own mutations on. */
export function installActionGate(bus: ExtensionBus): () => void {
  installedBus = bus;
  return () => {
    if (installedBus === bus) installedBus = null;
  };
}

/** A gated action that must not run; the message names the deciding extension. */
export class ActionDeniedError extends GuardError {
  constructor(
    readonly reason: string,
    readonly ext?: string,
  ) {
    super(ext ? `Denied by extension ${ext}: ${reason}` : `Denied: ${reason}`);
    this.name = "ActionDeniedError";
  }
}

type ActionInput = Omit<EventInput, "name"> & { name: ActionEventName };

/**
 * Gates one action. Resolves with the event after validated rewrites, or
 * rejects with ActionDeniedError. Without a subscriber nothing awaits.
 */
export function gateAction(
  input: ActionInput,
  bus: ExtensionBus | null = installedBus,
): ExtensionEventBase | Promise<ExtensionEventBase> {
  const event: EventInput = {
    ...input,
    origin: input.origin ?? currentOrigin(),
  };
  if (!bus?.wants(event.name)) return { ...event, at: event.at ?? Date.now() };
  return decide(bus, event);
}

async function decide(
  bus: ExtensionBus,
  input: EventInput,
): Promise<ExtensionEventBase> {
  const { gate, event } = await bus.gate(input);
  const decided =
    gate.decision === "ask" ? await resolveAsk(gate, event) : gate;
  if (decided.decision === "deny")
    throw new ActionDeniedError(decided.reason, decided.ext);
  return event;
}

/** Herdr methods that mutate through Roamgate, by the action event they raise. */
export const HERDR_METHOD_ACTIONS: Readonly<Record<string, ActionEventName>> = {
  "pane.send_text": "terminal.submit",
  "pane.send_input": "terminal.submit",
  "pane.send_keys": "terminal.keys",
  "pane.close": "pane.close",
  "tab.close": "tab.close",
  "workspace.close": "workspace.close",
  "pane.split": "pane.split",
  "tab.create": "tab.create",
  "workspace.create": "workspace.create",
};

/** Every browser RPC method that raises an action event before it runs. */
export const RPC_METHOD_ACTIONS: Readonly<Record<string, ActionEventName>> = {
  ...HERDR_METHOD_ACTIONS,
  "worktree.create": "worktree.create",
  "worktree.remove": "worktree.remove",
  "file.mkdir": "file.write",
  "file.move": "file.write",
  "git.pull": "git.mutate",
  "git.file_action": "git.mutate",
  "git.repo_action": "git.mutate",
  "settings.agent_auto_rename.update": "settings.change",
  "settings.terminal_transport.update": "settings.change",
  "settings.update_repo": "settings.change",
  "settings.workspace_auto_sync.update": "settings.change",
  "settings.workspace_auto_sync.update_key": "settings.change",
  "settings.worktree_command.update": "settings.change",
  "bridge.ui_settings.update": "settings.change",
};

/**
 * Browser RPC methods that raise no action event: reads, focus and layout
 * moves, terminal streaming, Ranger (its actions gate when they run),
 * connection and extension management. Every method is in exactly one of
 * this set and RPC_METHOD_ACTIONS; a test enforces it.
 */
export const UNGATED_RPC_METHODS: ReadonlySet<string> = new Set([
  "action.cancel",
  "action.confirm",
  "agent.list",
  "agent_artifacts.get",
  "agent_commands.get",
  "agent_history.entry",
  "agent_history.get",
  "agent_seen.mark",
  "agent_session.get",
  "bridge.assistant.context",
  "bridge.assistant.mentions",
  "bridge.assistant.task.get",
  "bridge.pause_others",
  "bridge.ping",
  "bridge.status",
  "bridge.ui_settings.get",
  "connections.agent_sessions",
  "connections.connect",
  "connections.create",
  "connections.disconnect",
  "connections.list",
  "connections.remove",
  "connections.set_default",
  "connections.test",
  "connections.update",
  "file.list",
  "file.read",
  "file.resolve",
  "file.reveal",
  "file.search",
  "forward.candidates",
  "forward.close",
  "forward.open",
  // Despite their names these read one commit or its file.
  "git.commit",
  "git.commit_file",
  "git.commit_preview",
  "git.commits",
  "git.diff_file",
  "git.diff_summary",
  "git.pull_request",
  "integration.list",
  "pane.focus_direction",
  "pane.get",
  "pane.layout",
  "pane.move",
  "pane.resize",
  "pane.swap",
  "pane.zoom",
  "plugin.action.invoke",
  "plugin.action.list",
  "popup.close",
  "settings.agent_auto_rename.get",
  "settings.get",
  "settings.terminal_transport.get",
  "settings.workspace_auto_sync.get",
  "settings.workspace_auto_sync.list",
  "settings.worktree_directory.get",
  "settings.worktree_hooks.get",
  "tab.focus",
  "tab.move",
  "tab.rename",
  "workspace.focus",
  "workspace.list",
  "workspace.move",
  "workspace.path",
  "workspace.rename",
  "worktree.list",
  "worktree.open",
  // Reads and navigation the bridge itself sends to Herdr.
  "events.subscribe",
  "forward.list",
  "pane.focus",
  "pane.link.activate",
  "pane.link.resolve",
  "pane.list",
  "pane.scroll",
  "tab.list",
  "workspace.get",
]);

/** Method families handled wholesale elsewhere: terminal streaming and extension management. */
export const UNGATED_RPC_PREFIXES = ["terminal.", "ext.", "bridge.assistant."];

/** HTTP endpoints of a connection that write files, by `file.write` op. */
export const HTTP_ENDPOINT_FILE_OPS: Readonly<
  Record<string, "upload" | "delete">
> = {
  "file-upload": "upload",
  "file-delete": "delete",
  "terminal-upload": "upload",
  "upload-image": "upload",
};

const TARGET_FIELDS = ["workspace_id", "tab_id", "pane_id"] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Event fields for an RPC mutation, from the method's own params. */
export function actionEventFields(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of TARGET_FIELDS)
    if (typeof params[key] === "string") fields[key] = params[key];
  const action = RPC_METHOD_ACTIONS[method];
  if (method === "pane.send_keys") fields.keys = params.keys;
  else if (action === "terminal.submit") {
    fields.text = text(params.text) ?? "";
    fields.mode = method === "pane.send_text" ? "text" : "input";
  } else if (method === "pane.split") {
    fields.direction = params.direction;
    if (typeof params.target_pane_id === "string")
      fields.pane_id = params.target_pane_id;
  } else if (method === "tab.create" || method === "workspace.create") {
    const label = text(params.label) ?? text(params.name);
    if (label !== undefined) fields.label = label;
    if (typeof params.cwd === "string") fields.cwd = params.cwd;
  } else if (method === "worktree.create") {
    fields.branch = text(params.branch) ?? null;
    fields.path = text(params.path) ?? null;
  } else if (method === "worktree.remove") {
    fields.path = text(params.path) ?? null;
    fields.force = params.force === true;
  } else if (action === "file.write") {
    fields.op = method === "file.mkdir" ? "mkdir" : "move";
    fields.paths = [params.path, params.directory].filter(
      (path): path is string => typeof path === "string",
    );
  } else if (action === "git.mutate") {
    fields.op =
      method === "git.pull" ? "pull" : (text(params.action) ?? method);
    if (typeof params.message === "string") fields.message = params.message;
  } else if (action === "settings.change") fields.keys = Object.keys(params);
  return fields;
}

/** Applies a validated rewrite back onto the RPC params. */
export function applyActionRewrite(
  method: string,
  params: Record<string, unknown>,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const action = RPC_METHOD_ACTIONS[method];
  if (action === "terminal.submit")
    return typeof event.text === "string"
      ? { ...params, text: event.text }
      : params;
  if (method === "tab.create" || method === "workspace.create") {
    const next = { ...params };
    if (typeof event.label === "string")
      next[Object.hasOwn(params, "name") ? "name" : "label"] = event.label;
    if (typeof event.cwd === "string") next.cwd = event.cwd;
    return next;
  }
  if (method === "pane.split" && typeof event.cwd === "string")
    return { ...params, cwd: event.cwd };
  if (
    action === "git.mutate" &&
    typeof params.message === "string" &&
    typeof event.message === "string"
  )
    return { ...params, message: event.message };
  return params;
}

export interface ActionConnection {
  id: string;
  generation: number;
}

/**
 * The gate for every browser and extension RPC mutation: raises the method's
 * action event and returns the params to run with, rewrites applied.
 */
export async function gateRpcAction(
  connection: ActionConnection | undefined,
  method: string,
  params: Record<string, unknown>,
  options: { origin?: EventOrigin; bus?: ExtensionBus | null } = {},
): Promise<Record<string, unknown>> {
  const name = RPC_METHOD_ACTIONS[method];
  if (!name) return params;
  const event = await gateAction(
    {
      name,
      origin: options.origin,
      ...(connection ? { connection } : {}),
      ...actionEventFields(method, params),
    },
    options.bus === undefined ? installedBus : options.bus,
  );
  return applyActionRewrite(method, params, event);
}

/**
 * Text sent to a pane, from the composer or a Ranger prompt. Returns the text
 * to deliver after rewrites.
 */
export async function gatePaneInput(
  connection: ActionConnection,
  target: { workspace_id?: string; pane_id: string; agent?: string },
  text: string,
  mode: "text" | "input" = "text",
): Promise<string> {
  const event = await gateAction({
    name: "terminal.submit",
    connection,
    ...target,
    text,
    mode,
  });
  return typeof event.text === "string" ? event.text : text;
}

/** Answer of an `rpc.call` interceptor: run the method, or reply with this result. */
export type RpcCallOutcome =
  | { kind: "continue"; params: Record<string, unknown> }
  | { kind: "answer"; result: unknown };

/**
 * The experimental `rpc.call` event: handlers of extensions that opted in may
 * observe, rewrite params, answer with a result, or gate with a decision.
 */
export async function interceptRpcCall(
  connection: ActionConnection | undefined,
  method: string,
  params: Record<string, unknown>,
  bus: ExtensionBus | null = installedBus,
): Promise<RpcCallOutcome> {
  if (!bus?.wants("rpc.call")) return { kind: "continue", params };
  const outcome = await bus.run({
    name: "rpc.call",
    origin: currentOrigin(),
    ...(connection ? { connection } : {}),
    method,
    params,
  });
  const rewritten =
    outcome.event.params &&
    typeof outcome.event.params === "object" &&
    !Array.isArray(outcome.event.params)
      ? (outcome.event.params as Record<string, unknown>)
      : params;
  if (!outcome.answer) return { kind: "continue", params: rewritten };
  const value = outcome.answer.value as Record<string, unknown> | null;
  const decision = value && typeof value === "object" ? value.decision : null;
  if (decision === "deny")
    throw new ActionDeniedError(
      typeof value?.reason === "string" ? value.reason : "denied",
      outcome.answer.ext,
    );
  if (decision === "ask") {
    const gate = parseGate(value, outcome.answer.ext);
    const decided =
      gate.decision === "ask" ? await resolveAsk(gate, outcome.event) : gate;
    if (decided.decision === "deny")
      throw new ActionDeniedError(decided.reason, decided.ext);
    return { kind: "continue", params: rewritten };
  }
  if (decision === "allow") return { kind: "continue", params: rewritten };
  return { kind: "answer", result: outcome.answer.value };
}
