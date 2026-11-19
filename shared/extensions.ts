// Wire types shared by the bridge, the extension child runtime and the web app.
import type { ShortcutPlatform } from "./shortcuts";

export const EXTENSION_API_VERSION = "1.0";
export const EXTENSION_MANIFEST_FILE = "roamgate-extension.toml";

export const EXTENSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const EXTENSION_CAPABILITIES = [
  "ui",
  "gates",
  "commands",
  "workspace.read",
  "files.read",
  "files.write",
  "herdr.read",
  "herdr.write",
  "terminal.read",
  "terminal.write",
  "agent.sessions",
  "notifications",
  "process",
  "process.remote",
  "network",
  "http.routes",
  "ranger",
  "secrets",
] as const;
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

export const EXTENSION_PLATFORMS = ["linux", "macos", "windows"] as const;
export type ExtensionPlatform = (typeof EXTENSION_PLATFORMS)[number];

export type ExtensionMatcherValue =
  | string
  | number
  | boolean
  | null
  | { $regex: string; flags?: string }
  | ExtensionMatcherValue[];
/** Field -> exact value, any of an array of values, or a regular expression. */
export type ExtensionMatcher = Record<string, ExtensionMatcherValue>;

export type ExtensionSettingType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "secret"
  | "directory"
  | "file";

export interface ExtensionSetting {
  type: ExtensionSettingType;
  title: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  options?: Array<string | { value: string; label: string }>;
  min?: number;
  max?: number;
  scope?: "global" | "connection";
}

export interface ExtensionCommandContribution {
  id: string;
  title: string;
  icon?: string;
  keywords?: string[];
  detail?: string;
  danger?: boolean;
  when?: ExtensionMatcher;
}

export interface ExtensionKeybinding {
  command: string;
  key: string;
  when?: ExtensionMatcher;
}

export interface ExtensionSlotContribution {
  slot: string;
  id: string;
  title?: string;
  detail?: string;
  text?: string;
  icon?: string;
  tone?: ElementTone;
  tooltip?: string;
  command?: string;
  danger?: boolean;
  when?: ExtensionMatcher;
}

export interface ExtensionHookContribution {
  on: string;
  matcher?: ExtensionMatcher;
  command?: string[];
  url?: string;
  timeout?: number;
  on_failure?: "continue" | "block";
  platforms?: ExtensionPlatform[];
}

export interface ExtensionRouteContribution {
  kind: "webhook" | "proxy";
  name?: string;
  upstream?: string;
  path?: string;
  timeout?: number;
}

export interface ExtensionFrameContribution {
  id: string;
  entry: string;
  height?: number;
  csp?: { connect?: string[]; resource?: string[]; frame?: string[] };
}

export interface ExtensionThemeContribution {
  kind: "terminal" | "accent";
  file: string;
  id?: string;
  name?: string;
  /** The parsed theme file; validation fills it in. */
  data?: Record<string, unknown>;
}

export interface ExtensionLinkPattern {
  pattern: string;
  url: string;
}

export interface ExtensionComposerCommand {
  name: string;
  description?: string;
  arguments?: string;
  agents?: string[];
  expand?: string;
}

export interface ExtensionPreviewer {
  extensions?: string[];
  mime_types?: string[];
  frame: string;
}

export interface ExtensionBuildStep {
  command: string[];
  platforms?: ExtensionPlatform[];
  timeout?: number;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  api: string;
  min_roamgate_version?: string;
  description?: string;
  author?: { name?: string; url?: string; email?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  platforms?: ExtensionPlatform[];
  capabilities: ExtensionCapability[];
  network_hosts: string[];
  mod?: string;
  activation: string[];
  experimental: boolean;
  start_hint?: string;
  config: Record<string, ExtensionSetting>;
  build: ExtensionBuildStep[];
  commands: ExtensionCommandContribution[];
  keybindings: ExtensionKeybinding[];
  slots: ExtensionSlotContribution[];
  hooks: ExtensionHookContribution[];
  routes: ExtensionRouteContribution[];
  frames: ExtensionFrameContribution[];
  themes: ExtensionThemeContribution[];
  link_patterns: ExtensionLinkPattern[];
  composer_commands: ExtensionComposerCommand[];
  previewers: ExtensionPreviewer[];
}

// Events (CONTRACT §3).

export const OBSERVED_EVENTS = [
  "extension.activate",
  "extension.deactivate",
  "connection.ready",
  "connection.lost",
  "viewer.attach",
  "viewer.detach",
  "herdr.event",
  "agent.status",
  "agent.attention",
  "workspace.step",
  "notify.send",
  "command.run",
  "ui.render",
  "ui.action",
  "config.change",
  "ranger.tools",
  "rpc.call",
  "webhook",
  "frame.call",
] as const;

export const ACTION_EVENTS = [
  "terminal.submit",
  "terminal.keys",
  "pane.close",
  "tab.close",
  "workspace.close",
  "pane.split",
  "tab.create",
  "workspace.create",
  "agent.start",
  "worktree.create",
  "worktree.remove",
  "file.write",
  "git.mutate",
  "settings.change",
  "update.install",
  // A Ranger call of a mutating extension tool: {ext, tool, input}.
  "extension.tool",
] as const;

export type ActionEventName = (typeof ACTION_EVENTS)[number];
export type ExtensionEventName =
  | (typeof OBSERVED_EVENTS)[number]
  | ActionEventName;

export const EXTENSION_EVENTS: readonly ExtensionEventName[] = [
  ...OBSERVED_EVENTS,
  ...ACTION_EVENTS,
];

// API stability markers for every event and `$` method.

export type ApiStability = "stable" | "experimental" | "deprecated";

export interface ApiStabilityMarker {
  stability: ApiStability;
  /** Deprecated: the API version that deprecated it. */
  since?: string;
  /** Deprecated: what to use instead. */
  replacement?: string;
}

export interface ExtensionApiStability {
  /** Event name -> marker; `tool.*` covers every Ranger tool event. */
  events: Readonly<Record<string, ApiStabilityMarker>>;
  /** `ns.method` -> marker; `ns.*` covers a whole namespace. */
  methods: Readonly<Record<string, ApiStabilityMarker>>;
}

const STABLE: ApiStabilityMarker = { stability: "stable" };
const EXPERIMENTAL: ApiStabilityMarker = { stability: "experimental" };

const EVENT_STABILITY: Readonly<
  Record<ExtensionEventName | "tool.*", ApiStabilityMarker>
> = {
  "extension.activate": STABLE,
  "extension.deactivate": STABLE,
  "connection.ready": STABLE,
  "connection.lost": STABLE,
  "viewer.attach": STABLE,
  "viewer.detach": STABLE,
  "herdr.event": STABLE,
  "agent.status": STABLE,
  "agent.attention": STABLE,
  "workspace.step": STABLE,
  "notify.send": STABLE,
  "command.run": STABLE,
  "ui.render": STABLE,
  "ui.action": STABLE,
  "config.change": STABLE,
  "ranger.tools": STABLE,
  "rpc.call": EXPERIMENTAL,
  webhook: STABLE,
  "frame.call": STABLE,
  "terminal.submit": STABLE,
  "terminal.keys": STABLE,
  "pane.close": STABLE,
  "tab.close": STABLE,
  "workspace.close": STABLE,
  "pane.split": STABLE,
  "tab.create": STABLE,
  "workspace.create": STABLE,
  "agent.start": STABLE,
  "worktree.create": STABLE,
  "worktree.remove": STABLE,
  "file.write": STABLE,
  "git.mutate": STABLE,
  "settings.change": STABLE,
  "update.install": STABLE,
  "extension.tool": STABLE,
  "tool.*": STABLE,
};

/** Every `$` method: bridge calls plus the child-local `state`, `clock` and `log`. */
const METHOD_STABILITY: Readonly<Record<string, ApiStabilityMarker>> = {
  "config.all": STABLE,
  "config.get": STABLE,
  "store.get": STABLE,
  "store.set": STABLE,
  "store.delete": STABLE,
  "store.keys": STABLE,
  "state.*": STABLE,
  "clock.now": STABLE,
  "clock.setTimeout": STABLE,
  "clock.clearTimeout": STABLE,
  "clock.setInterval": STABLE,
  "clock.clearInterval": STABLE,
  "log.debug": STABLE,
  "log.info": STABLE,
  "log.warn": STABLE,
  "log.error": STABLE,
  "roamgate.connections": STABLE,
  "roamgate.workspaces": STABLE,
  "roamgate.tabs": STABLE,
  "roamgate.panes": STABLE,
  "roamgate.agents": STABLE,
  "herdr.call": STABLE,
  "terminal.send": STABLE,
  "terminal.keys": STABLE,
  "terminal.screen": STABLE,
  "agent.session": STABLE,
  "agent.history": STABLE,
  "notify.push": STABLE,
  "ui.toast": STABLE,
  "ui.invalidate": STABLE,
  "ui.ask": STABLE,
  "events.emit": STABLE,
  "process.run": STABLE,
  "http.fetch": STABLE,
  "files.read": STABLE,
  "files.write": STABLE,
};

export const API_STABILITY: ExtensionApiStability = {
  events: EVENT_STABILITY,
  methods: METHOD_STABILITY,
};

/** An event's marker, or undefined for names outside the API. */
export function eventStability(
  event: string,
  table: ExtensionApiStability = API_STABILITY,
): ApiStabilityMarker | undefined {
  return (
    table.events[event] ??
    (isToolEvent(event) ? table.events["tool.*"] : undefined)
  );
}

/** A `ns.method` call's marker, or undefined for calls outside the API. */
export function methodStability(
  call: string,
  table: ExtensionApiStability = API_STABILITY,
): ApiStabilityMarker | undefined {
  return table.methods[call] ?? table.methods[`${call.split(".")[0] ?? ""}.*`];
}

/** One line describing a deprecated API, for validate and the extension log. */
export function describeDeprecation(
  api: string,
  marker: ApiStabilityMarker,
): string {
  return `${api} is deprecated${marker.since ? ` since API ${marker.since}` : ""} and will be removed in a later version${marker.replacement ? `; use ${marker.replacement}` : ""}`;
}

/** Events that need `experimental = true` in the manifest. */
export const EXPERIMENTAL_EVENTS: ReadonlySet<string> = new Set(
  Object.entries(EVENT_STABILITY)
    .filter(([, marker]) => marker.stability === "experimental")
    .map(([event]) => event),
);

const ACTION_EVENT_SET: ReadonlySet<string> = new Set(ACTION_EVENTS);
const EVENT_SET: ReadonlySet<string> = new Set(EXTENSION_EVENTS);

export function isActionEvent(name: string): name is ActionEventName {
  return ACTION_EVENT_SET.has(name);
}

export function isExtensionEvent(name: string): name is ExtensionEventName {
  return EVENT_SET.has(name);
}

/** A Ranger extension tool's name; its mod handler event is `tool.<name>`. */
export const EXTENSION_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isToolEvent(name: string): boolean {
  return (
    name.startsWith("tool.") && EXTENSION_TOOL_NAME_PATTERN.test(name.slice(5))
  );
}

/**
 * Fields a handler may change with `next(rewritten)`; others are dropped.
 * Created names are `label`, since `name` is the event's own name.
 */
export const REWRITABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "agent.attention": ["title", "body"],
  "notify.send": ["title", "body"],
  "terminal.submit": ["text"],
  "pane.split": ["cwd"],
  "tab.create": ["label", "cwd"],
  "workspace.create": ["label", "cwd"],
  "agent.start": ["label", "cwd"],
  "git.mutate": ["message"],
  "rpc.call": ["params"],
};

/** Events whose default behaviour an answer of `{suppress: true}` cancels. */
export const SUPPRESSIBLE_EVENTS: ReadonlySet<string> = new Set([
  "agent.attention",
  "notify.send",
]);

export const DEFAULT_HANDLER_BUDGET_MS = 5_000;
export const HANDLER_BUDGET_CEILING_MS = 10 * 60_000;
export const EVENT_HANDLER_BUDGETS_MS: Readonly<Record<string, number>> = {
  "ui.render": 250,
  "terminal.submit": 2_000,
  "terminal.keys": 2_000,
};

export function handlerBudgetMs(event: string): number {
  return EVENT_HANDLER_BUDGETS_MS[event] ?? DEFAULT_HANDLER_BUDGET_MS;
}

export type EventOrigin = "browser" | "ranger" | "task" | `extension:${string}`;

export interface ExtensionEventBase {
  name: string;
  at: number;
  origin?: EventOrigin;
  connection?: { id: string; generation: number };
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  checkout_path?: string;
  agent?: string;
  viewer?: { id: string; mobile: boolean };
  [field: string]: unknown;
}

export type Gate =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | {
      decision: "ask";
      title: string;
      body?: string;
      detail?: string;
      risk?: "low" | "medium" | "high";
      timeout_ms?: number;
      on_timeout?: "deny" | "allow";
    };

export type GateDecision = Gate["decision"];

/** Decisions combine as deny > ask > allow. */
export function gateRank(decision: GateDecision): number {
  return decision === "deny" ? 2 : decision === "ask" ? 1 : 0;
}

function matcherValueMatches(
  expected: ExtensionMatcherValue,
  actual: unknown,
): boolean {
  if (Array.isArray(expected))
    return expected.some((value) => matcherValueMatches(value, actual));
  if (expected && typeof expected === "object") {
    if (typeof actual !== "string") return false;
    try {
      return new RegExp(expected.$regex, expected.flags).test(actual);
    } catch {
      return false;
    }
  }
  return expected === actual;
}

function eventField(event: Record<string, unknown>, path: string): unknown {
  let value: unknown = event;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** True when every matcher field matches the event (an empty matcher matches all). */
export function matchesEvent(
  matcher: ExtensionMatcher | undefined,
  event: Record<string, unknown>,
): boolean {
  if (!matcher) return true;
  for (const [field, expected] of Object.entries(matcher)) {
    if (!matcherValueMatches(expected, eventField(event, field))) return false;
  }
  return true;
}

// Elements and slot data (CONTRACT §4).

export const EXTENSION_SLOTS = [
  "command",
  "menu.item",
  "topbar.item",
  "statusbar.item",
  "sidebar.section",
  "inspector.panel",
  "workspace.surface",
  "workspace.badge",
  "agent.badge",
  "tab.badge",
  "context-menu.workspace",
  "context-menu.agent",
  "context-menu.tab",
  "pane.toolbar",
  "pane.overlay",
  "composer.command",
  "settings.section",
  "toast",
] as const;
export type ExtensionSlot = (typeof EXTENSION_SLOTS)[number];

export type ElementTone = "neutral" | "info" | "success" | "warning" | "danger";

export type El =
  | { t: "Stack" | "Row"; id?: string; gap?: 0 | 1 | 2 | 3; children: El[] }
  | {
      t: "Text";
      text: string;
      tone?: ElementTone;
      weight?: "normal" | "strong";
      mono?: boolean;
    }
  | { t: "Markdown"; md: string }
  | { t: "Code"; code: string; lang?: string }
  | { t: "Badge"; text: string; tone?: ElementTone }
  | { t: "Icon"; name: string }
  | {
      t: "Button";
      id: string;
      label: string;
      icon?: string;
      tone?: ElementTone;
      command?: string;
      disabled?: boolean;
    }
  | { t: "Link"; href: string; label: string }
  | { t: "Input" | "TextArea"; id: string; value: string; placeholder?: string }
  | {
      t: "Select";
      id: string;
      value: string;
      options: Array<{ value: string; label: string }>;
    }
  | { t: "Toggle"; id: string; value: boolean; label: string }
  | { t: "Progress"; value?: number }
  | { t: "Spinner" }
  | { t: "List"; items: El[] }
  | { t: "Table"; columns: string[]; rows: El[][] }
  | { t: "KeyValue"; items: Array<{ k: string; v: El }> }
  | { t: "Divider" }
  | { t: "Image"; src: string; alt: string }
  | { t: "Empty"; title: string; body?: string }
  | { t: "Frame"; frame: string; height?: number };

export const ELEMENT_LIMITS = {
  depth: 16,
  nodes: 2_000,
  bytes: 256 * 1024,
} as const;

export interface CommandSlotData {
  title: string;
  detail?: string;
  icon?: string;
  command: string;
  danger?: boolean;
  disabled_reason?: string;
}

export interface BadgeSlotData {
  text?: string;
  icon?: string;
  tone: ElementTone;
  tooltip: string;
  command?: string;
}

export interface ContextMenuSlotData {
  groups: Array<{
    label: string;
    items: Array<{
      key: string;
      label: string;
      detail?: string;
      danger?: boolean;
      disabled_reason?: string;
      command: string;
    }>;
  }>;
}

export interface StatusBarSlotData {
  text: string;
  tone?: ElementTone;
  icon?: string;
  tooltip?: string;
  command?: string;
}

export interface ComposerCommandSlotData {
  name: string;
  description: string;
  arguments?: string;
  expand?: string;
}

export interface ToastSlotData {
  kind: "info" | "success" | "warning" | "error";
  message: string;
  detail?: string;
  command?: string;
}

// Bridge <-> child stdio protocol (CONTRACT §2).

export const EXTENSION_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  capability: -32010,
  connectionChanged: -32011,
  timeout: -32012,
  guard: -32013,
} as const;

export interface HandlerRegistration {
  handler_id: string;
  event: string;
  matcher?: ExtensionMatcher;
  on_failure: "continue" | "block";
}

export interface ChildInitParams {
  id: string;
  root: string;
  data: string;
  api: string;
  config: Record<string, unknown>;
  platform: string;
  /** Absolute path of the mod module inside `root`. */
  mod: string;
}

export interface ChildInitResult {
  registrations: HandlerRegistration[];
  commands: string[];
}

export interface ChildHandleParams {
  call_id: string;
  handler_id: string;
  event: string;
  payload: ExtensionEventBase;
}

export type ChildHandleResult =
  | { kind: "next"; payload?: ExtensionEventBase }
  | { kind: "answer"; value: unknown }
  | { kind: "error"; message: string };

export interface DollarCallParams {
  call_id?: string;
  ns: string;
  method: string;
  args: unknown[];
}

export interface ChildLogParams {
  level: "error" | "warn" | "info" | "debug";
  message: string;
  fields?: Record<string, unknown>;
}

// Browser <-> bridge RPC (CONTRACT §6) and pushes.

export type ExtensionStatus =
  | "active"
  | "idle"
  | "disabled"
  | "failed"
  | "invalid"
  | "incompatible"
  | "safe_mode";

/** An earlier binding that keeps a key an extension keybinding wanted. */
export interface ExtensionKeybindingConflict {
  platform: ShortcutPlatform;
  key: string;
  /** A built-in shortcut id, or `ext:<id>:<command>` for an earlier extension. */
  winner: string;
  kind: "builtin" | "extension";
}

export interface ExtensionKeybindingState extends ExtensionKeybinding {
  /** The key in the web app's shortcut form, per platform; the bridge sets it. */
  keys?: Record<ShortcutPlatform, string>;
  /** Platforms where it loses and does not apply; the bridge sets it. */
  conflicts?: ExtensionKeybindingConflict[];
}

export interface ExtensionContributions {
  commands: ExtensionCommandContribution[];
  slots: ExtensionSlotContribution[];
  keybindings: ExtensionKeybindingState[];
  /** Declared frames; the web host builds `/ext/<id>/frame/<entry>` from these. */
  frames?: ExtensionFrameContribution[];
  /** Themes with the parsed file content, so browsers never fetch extension files. */
  themes?: Array<ExtensionThemeContribution & { data: unknown }>;
  link_patterns?: ExtensionLinkPattern[];
  composer_commands?: ExtensionComposerCommand[];
  previewers?: ExtensionPreviewer[];
}

export interface ExtensionStateEntry {
  id: string;
  name: string;
  version: string;
  status: ExtensionStatus;
  enabled: boolean;
  capabilities: ExtensionCapability[];
  contributions: ExtensionContributions;
  /** Why the extension is not running, for incompatible, invalid and failed entries. */
  reason?: string;
  last_error?: { at: number; message: string };
}

export interface ExtensionStateResult {
  safe_mode: boolean;
  api: string;
  extensions: ExtensionStateEntry[];
}

export type ExtensionManageParams =
  | { op: "enable" | "disable"; id: string }
  | { op: "order"; ids: string[] }
  | { op: "safe_mode"; enabled: boolean }
  | { op: "uninstall"; id: string; keep_data?: boolean }
  /** Without `accept`, returns the consent summary; with it, records consent. */
  | { op: "consent"; id: string; accept?: boolean }
  /** Shows the webhook bearer token, created on first use; `rotate` replaces it. */
  | { op: "webhook_token"; id: string; rotate?: boolean };

export interface ExtensionWebhookTokenResult {
  token: string;
  /** Path the hook names follow: `<url_base><name>`, relative to this server. */
  url_base: string;
}

/**
 * `webhook` event: a POST to `/api/ext/<id>/hooks/<route>` with a valid
 * bearer token. Match `{route}` to pick one hook; the answer value is the
 * JSON response body.
 */
export interface ExtensionWebhookEvent extends ExtensionEventBase {
  name: "webhook";
  route: string;
  body: unknown;
  query: Record<string, string>;
}

/**
 * `frame.call` event: a frame's `roamgate/call` through `ext.frame.call`.
 * Match `{frame, method}`; the answer value is the call's result.
 */
export interface ExtensionFrameCallEvent extends ExtensionEventBase {
  name: "frame.call";
  frame: string;
  method: string;
  params: unknown;
}

export interface ExtensionFrameCallParams {
  ext: string;
  frame: string;
  method: string;
  params?: unknown;
}

export interface ExtensionInstallPreviewParams {
  source: string;
  ref?: string;
  /** Required for archive URLs. */
  sha256?: string;
}

export interface ExtensionInstallApplyParams {
  preview_id: string;
}

export interface ExtensionConfigGetParams {
  ext: string;
  connection_id?: string;
}

export interface ExtensionConfigSetParams {
  ext: string;
  key: string;
  value: unknown;
  connection_id?: string;
}

/** Longest text a `terminal.submit` rewrite may produce; longer rewrites are rejected. */
export const TERMINAL_SUBMIT_TEXT_MAX = 65_536;
/** Per-field limits on rewritten values; a rewrite over any of them is dropped whole. */
export const REWRITE_TEXT_LIMITS: Readonly<Record<string, number>> = {
  text: TERMINAL_SUBMIT_TEXT_MAX,
  title: 200,
  body: 2_000,
  label: 200,
  cwd: 4_096,
  message: 10_000,
};

export interface ExtensionCommandRunParams {
  ext: string;
  command: string;
  context?: Record<string, unknown>;
}

export interface ExtensionLogLine {
  at: number;
  level: ChildLogParams["level"];
  line: string;
}

/** An `ask` waiting for a person; pushed to every browser. */
export interface PendingApproval {
  id: string;
  ext: string;
  /** The action event, or `ui.ask` for an extension's own question. */
  event: string;
  title: string;
  body?: string;
  detail?: string;
  risk?: "low" | "medium" | "high";
  origin: EventOrigin;
  connection_id?: string;
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  created_at: number;
  expires_at: number;
  on_timeout: "deny" | "allow";
}

export type ApprovalCause =
  | "approved"
  | "denied"
  | "timed out"
  | "extension disabled"
  | "safe mode"
  | "connection changed"
  | "shutdown";

export interface ApprovalAnswerParams {
  id: string;
  decision: "approve" | "deny";
  /** The answering device, recorded on the receipt. */
  device?: string;
}

export type ApprovalAnswerResult = { ok: true } | { already_decided: true };

export interface ApprovalReceipt {
  id: string;
  ext: string;
  event: string;
  title: string;
  decision: "allow" | "deny";
  cause: ApprovalCause;
  device: string | null;
  origin: string;
  connection_id: string | null;
  workspace_id: string | null;
  pane_id: string | null;
  created_at: number;
  decided_at: number;
}

export interface ExtensionReceiptsParams {
  ext?: string;
  limit?: number;
  before?: number;
}

/** Context of a slot render: carries the connection it was rendered for. */
export interface ExtensionSlotContext {
  connection_id?: string;
  generation?: number;
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
  agent?: string;
  [key: string]: unknown;
}

export interface ExtensionUiRenderParams {
  slot: string;
  context?: ExtensionSlotContext;
  viewer?: {
    mobile?: boolean;
    theme?: string;
    accent?: string;
    width?: number;
  };
}

export interface ExtensionUiRenderEntry {
  ext: string;
  entry_id: string;
  value: unknown;
}

export interface ExtensionUiRenderResult {
  entries: ExtensionUiRenderEntry[];
}

export interface ExtensionUiActionParams {
  ext: string;
  slot: string;
  entry_id: string;
  element_id: string;
  value?: unknown;
  context?: ExtensionSlotContext;
}

export type ExtensionsPush =
  | { state: ExtensionStateResult }
  | { invalidate: { ext: string; slot?: string } }
  | { approvals: PendingApproval[] }
  | { toast: ToastSlotData & { ext: string } }
  | {
      /** From `$.events.emit`; without `frame`, every frame of `ext` gets it. */
      frame_event: { ext: string; frame?: string; name: string; data: unknown };
    };

/** File name of a marketplace catalog (RF-01-66). */
export const MARKETPLACE_CATALOG_FILE = "roamgate-marketplace.json";

/** One extension listed by a marketplace catalog. */
export interface MarketplaceCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Optional; lets browsers show that a newer version is listed. */
  version?: string;
  /** `owner/repo[/subdir]`, a git URL, or an HTTPS archive URL. */
  source: string;
  /** Full 40-hex commit SHA a git source is pinned to. */
  ref?: string;
  /** SHA-256 of an archive source; required for archives. */
  sha256?: string;
  tags: string[];
}

export interface MarketplaceCatalog {
  name: string;
  description?: string;
  extensions: MarketplaceCatalogEntry[];
}

/** A configured marketplace, from `marketplaces.json`. */
export interface MarketplaceInfo {
  name: string;
  /** What `marketplace add` was given. */
  source: string;
  kind: "github" | "git" | "url" | "file";
  description?: string;
  added_at: number;
  refreshed_at: number;
  /** Commit of the catalog repository at the last refresh, for git sources. */
  commit?: string;
  entries: number;
}

/** `ext.install.preview` params that install a catalog entry at its pin. */
export interface MarketplaceInstallParams {
  source: string;
  ref?: string;
  sha256?: string;
}

export interface MarketplaceBrowseEntry extends MarketplaceCatalogEntry {
  marketplace: string;
  install: MarketplaceInstallParams;
  /** Null when no extension with this id is installed or linked. */
  installed: {
    version: string;
    source: string;
    resolved?: string;
    enabled: boolean;
    /** Installed from this entry's source at exactly its pin. */
    pinned: boolean;
    /** Installed from this entry's source, and the catalog lists another pin or version. */
    update_available: boolean;
  } | null;
}
