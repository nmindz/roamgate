// Roamgate extension SDK, API 1.0. `roamgate ext types` writes this file as
// roamgate.d.ts; import from it with type-only imports, which Bun erases:
//
//   import type { On } from "roamgate";
//   export function register(on: On) { ... }

declare module "roamgate" {
  export type ApiVersion = "1.0";

  export type Capability =
    | "ui"
    | "gates"
    | "commands"
    | "workspace.read"
    | "files.read"
    | "files.write"
    | "herdr.read"
    | "herdr.write"
    | "terminal.read"
    | "terminal.write"
    | "agent.sessions"
    | "notifications"
    | "process"
    | "process.remote"
    | "network"
    | "http.routes"
    | "ranger"
    | "secrets";

  export type Platform = "linux" | "macos" | "windows";

  // Manifest (roamgate-extension.toml), as Roamgate reads it.

  /** A matcher value as stored: exact value, any of an array, or a regex. */
  export type MatcherValue =
    | string
    | number
    | boolean
    | null
    | { $regex: string; flags?: string }
    | MatcherValue[];
  export type Matcher = Record<string, MatcherValue>;

  export type SettingType =
    | "string"
    | "number"
    | "boolean"
    | "select"
    | "secret"
    | "directory"
    | "file";

  export interface Setting {
    type: SettingType;
    title: string;
    description?: string;
    default?: string | number | boolean;
    required?: boolean;
    options?: Array<string | { value: string; label: string }>;
    min?: number;
    max?: number;
    scope?: "global" | "connection";
  }

  export interface CommandContribution {
    id: string;
    title: string;
    icon?: string;
    keywords?: string[];
    detail?: string;
    danger?: boolean;
    when?: Matcher;
  }

  export interface Keybinding {
    command: string;
    key: string;
    when?: Matcher;
  }

  export interface SlotContribution {
    slot: string;
    id: string;
    title?: string;
    detail?: string;
    text?: string;
    icon?: string;
    tone?: Tone;
    tooltip?: string;
    command?: string;
    danger?: boolean;
    when?: Matcher;
  }

  export interface HookContribution {
    on: string;
    matcher?: Matcher;
    command?: string[];
    url?: string;
    timeout?: number;
    on_failure?: "continue" | "block";
    platforms?: Platform[];
  }

  export interface RouteContribution {
    kind: "webhook" | "proxy";
    name?: string;
    upstream?: string;
    path?: string;
    timeout?: number;
  }

  export interface FrameContribution {
    id: string;
    entry: string;
    height?: number;
    csp?: { connect?: string[]; resource?: string[]; frame?: string[] };
  }

  export interface ThemeContribution {
    kind: "terminal" | "accent";
    file: string;
    id?: string;
    name?: string;
  }

  export interface LinkPattern {
    pattern: string;
    url: string;
  }

  export interface ComposerCommand {
    name: string;
    description?: string;
    arguments?: string;
    agents?: string[];
    expand?: string;
  }

  export interface Previewer {
    extensions?: string[];
    mime_types?: string[];
    frame: string;
  }

  export interface BuildStep {
    command: string[];
    platforms?: Platform[];
    timeout?: number;
  }

  export interface Manifest {
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
    platforms?: Platform[];
    capabilities: Capability[];
    network_hosts: string[];
    mod?: string;
    activation: string[];
    experimental: boolean;
    start_hint?: string;
    config: Record<string, Setting>;
    build: BuildStep[];
    commands: CommandContribution[];
    keybindings: Keybinding[];
    slots: SlotContribution[];
    hooks: HookContribution[];
    routes: RouteContribution[];
    frames: FrameContribution[];
    themes: ThemeContribution[];
    link_patterns: LinkPattern[];
    composer_commands: ComposerCommand[];
    previewers: Previewer[];
  }

  // Elements and slot data.

  export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

  export type Slot =
    | "command"
    | "menu.item"
    | "topbar.item"
    | "statusbar.item"
    | "sidebar.section"
    | "inspector.panel"
    | "workspace.surface"
    | "workspace.badge"
    | "agent.badge"
    | "tab.badge"
    | "context-menu.workspace"
    | "context-menu.agent"
    | "context-menu.tab"
    | "pane.toolbar"
    | "pane.overlay"
    | "composer.command"
    | "settings.section"
    | "toast";

  /** A UI element. Limits: depth 16, 2,000 nodes, 256 KiB serialized. */
  export type Element =
    | {
        t: "Stack" | "Row";
        id?: string;
        gap?: 0 | 1 | 2 | 3;
        children: Element[];
      }
    | {
        t: "Text";
        text: string;
        tone?: Tone;
        weight?: "normal" | "strong";
        mono?: boolean;
      }
    /** No raw HTML, no remote images. */
    | { t: "Markdown"; md: string }
    | { t: "Code"; code: string; lang?: string }
    | { t: "Badge"; text: string; tone?: Tone }
    | { t: "Icon"; name: string }
    | {
        t: "Button";
        id: string;
        label: string;
        icon?: string;
        tone?: Tone;
        command?: string;
        disabled?: boolean;
      }
    /** http(s) only. */
    | { t: "Link"; href: string; label: string }
    | {
        t: "Input" | "TextArea";
        id: string;
        value: string;
        placeholder?: string;
      }
    | {
        t: "Select";
        id: string;
        value: string;
        options: Array<{ value: string; label: string }>;
      }
    | { t: "Toggle"; id: string; value: boolean; label: string }
    | { t: "Progress"; value?: number }
    | { t: "Spinner" }
    | { t: "List"; items: Element[] }
    | { t: "Table"; columns: string[]; rows: Element[][] }
    | { t: "KeyValue"; items: Array<{ k: string; v: Element }> }
    | { t: "Divider" }
    /** `src` is a data: URL or an extension asset. */
    | { t: "Image"; src: string; alt: string }
    | { t: "Empty"; title: string; body?: string }
    | { t: "Frame"; frame: string; height?: number };

  /** `command`, `menu.item`, `pane.toolbar`, `topbar.item`. */
  export interface CommandSlotData {
    title: string;
    detail?: string;
    icon?: string;
    command: string;
    danger?: boolean;
    disabled_reason?: string;
  }

  /** `*.badge`. */
  export interface BadgeSlotData {
    text?: string;
    icon?: string;
    tone: Tone;
    tooltip: string;
    command?: string;
  }

  /** `context-menu.*`. */
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
    tone?: Tone;
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

  export type SlotData =
    | CommandSlotData
    | BadgeSlotData
    | ContextMenuSlotData
    | StatusBarSlotData
    | ComposerCommandSlotData
    | ToastSlotData;

  // Gates.

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

  // Events. Payloads are frozen; unknown fields read as `unknown`.

  export type EventOrigin =
    | "browser"
    | "ranger"
    | "task"
    | `extension:${string}`;

  export interface ConnectionRef {
    id: string;
    generation: number;
  }

  export interface EventBase {
    name: string;
    at: number;
    origin?: EventOrigin;
    connection?: ConnectionRef;
    workspace_id?: string;
    tab_id?: string;
    pane_id?: string;
    checkout_path?: string;
    agent?: string;
    viewer?: { id: string; mobile: boolean };
    [field: string]: unknown;
  }

  /** Where a slot is rendered; carries the connection it was rendered for. */
  export interface SlotContext {
    connection_id?: string;
    generation?: number;
    workspace_id?: string;
    tab_id?: string;
    pane_id?: string;
    agent?: string;
    [key: string]: unknown;
  }

  type EventOf<N extends string, F = {}> = EventBase & { name: N } & F;

  export interface ObservedEvents {
    "extension.activate": EventOf<"extension.activate", { ext: string }>;
    "extension.deactivate": EventOf<"extension.deactivate", { ext: string }>;
    "connection.ready": EventOf<"connection.ready">;
    "connection.lost": EventOf<"connection.lost", { state: string }>;
    "viewer.attach": EventOf<"viewer.attach">;
    "viewer.detach": EventOf<"viewer.detach">;
    "herdr.event": EventOf<"herdr.event", { event: string; data: unknown }>;
    "agent.status": EventOf<
      "agent.status",
      { from: string | null; to: string | null }
    >;
    /** Rewritable: `title`, `body`. Answer `{suppress: true}` to cancel it. */
    "agent.attention": EventOf<
      "agent.attention",
      { kind: string; title: string | null; body: string | null }
    >;
    "workspace.step": EventOf<"workspace.step", { captured: unknown }>;
    /** Rewritable: `title`, `body`. Answer `{suppress: true}` to cancel it. */
    "notify.send": EventOf<
      "notify.send",
      { title: string; body: string; target?: unknown }
    >;
    /** Match `{command}`; the answer is the command's result. */
    "command.run": EventOf<"command.run", { command: string; args: unknown }>;
    /** Match `{slot}`; answer an element tree or the slot's data. */
    "ui.render": EventOf<
      "ui.render",
      {
        slot: string;
        entry_id: string;
        context: SlotContext;
        viewer: {
          id: string;
          mobile: boolean;
          theme?: string;
          accent?: string;
          width?: number;
        };
      }
    >;
    "ui.action": EventOf<
      "ui.action",
      { slot: string; entry_id: string; element_id: string; value: unknown }
    >;
    "config.change": EventOf<"config.change", { keys: string[] }>;
    /** Answer the Ranger tools this extension offers. */
    "ranger.tools": EventOf<"ranger.tools">;
    /** Experimental. Rewritable: `params`. Answer a result or a Gate. */
    "rpc.call": EventOf<"rpc.call", { method: string; params: unknown }>;
    /** A POST to `/api/ext/<id>/hooks/<route>`; the answer is the JSON body. */
    webhook: EventOf<
      "webhook",
      { route: string; body: unknown; query: Record<string, string> }
    >;
    /** A frame's `roamgate/call`; the answer is the call's result. */
    "frame.call": EventOf<
      "frame.call",
      { frame: string; method: string; params: unknown }
    >;
  }

  /** Answered with a Gate; combined across extensions as deny > ask > allow. */
  export interface ActionEvents {
    /** Rewritable: `text`. */
    "terminal.submit": EventOf<
      "terminal.submit",
      { text: string; mode: "text" | "input" }
    >;
    "terminal.keys": EventOf<"terminal.keys", { keys: string[] }>;
    "pane.close": EventOf<"pane.close">;
    "tab.close": EventOf<"tab.close">;
    "workspace.close": EventOf<"workspace.close">;
    /** Rewritable: `cwd`. */
    "pane.split": EventOf<"pane.split", { direction?: string; cwd?: string }>;
    /** Rewritable: `label`, `cwd`. */
    "tab.create": EventOf<"tab.create", { label?: string; cwd?: string }>;
    /** Rewritable: `label`, `cwd`. */
    "workspace.create": EventOf<
      "workspace.create",
      { label?: string; cwd?: string }
    >;
    /** Rewritable: `label`, `cwd`. */
    "agent.start": EventOf<
      "agent.start",
      { agent: string; label?: string; cwd?: string }
    >;
    "worktree.create": EventOf<
      "worktree.create",
      { branch?: string; path?: string }
    >;
    "worktree.remove": EventOf<
      "worktree.remove",
      { path?: string; force?: boolean }
    >;
    "file.write": EventOf<
      "file.write",
      { op: "upload" | "mkdir" | "move" | "delete"; paths: string[] }
    >;
    /** Rewritable: `message`. */
    "git.mutate": EventOf<"git.mutate", { op: string; message?: string }>;
    "settings.change": EventOf<"settings.change", { keys: string[] }>;
    "update.install": EventOf<"update.install", { version: string }>;
    /** A Ranger call of a mutating extension tool. */
    "extension.tool": EventOf<
      "extension.tool",
      { ext: string; tool: string; input: unknown }
    >;
  }

  export interface Events extends ObservedEvents, ActionEvents {}
  export type EventName = keyof Events;
  export type ActionEventName = keyof ActionEvents;

  /** `tool.<name>`: a Ranger call of one of this extension's tools. */
  export type ToolEvent = EventBase & {
    name: `tool.${string}`;
    input: unknown;
  };

  const passed: unique symbol;
  /** What `next()` resolves to; return it to pass the event on. */
  export type Passed = typeof passed;

  /** Passes the event on, rewritten when given (rewritable fields only). */
  export type Next<E extends EventBase = EventBase> = (
    rewritten?: E,
  ) => Promise<Passed>;

  type Awaitable<T> = T | Promise<T>;

  /**
   * Any JSON value. Spelled out rather than `unknown` so object literals in
   * answers keep their literal types.
   */
  export type AnyAnswer =
    | object
    | string
    | number
    | boolean
    | null
    | undefined
    | void;
  type Observed = Passed | null | undefined | void;
  type Suppress = { suppress: true } | Observed;
  type GateAnswer = Gate | Passed | undefined | void;

  /**
   * A command answer that opens this extension's own proxied web page
   * (`/ext/<id>/web/<path>`) over the workspace. Other paths are ignored.
   */
  export interface CommandAnswer {
    open?: string;
  }

  /** What a handler may return; `undefined` or `next()` passes the event on. */
  export interface Answers {
    "extension.activate": Observed;
    "extension.deactivate": Observed;
    "connection.ready": Observed;
    "connection.lost": Observed;
    "viewer.attach": Observed;
    "viewer.detach": Observed;
    "herdr.event": Observed;
    "agent.status": Observed;
    "agent.attention": Suppress;
    "workspace.step": Observed;
    "notify.send": Suppress;
    /** `{ open: "/ext/<own-id>/web/..." }` opens that proxied page over the workspace. */
    "command.run": CommandAnswer | AnyAnswer;
    "ui.render": Element | SlotData | Observed;
    "ui.action": AnyAnswer;
    "config.change": Observed;
    "ranger.tools": AnyAnswer;
    "rpc.call": AnyAnswer;
    webhook: AnyAnswer;
    "frame.call": AnyAnswer;
    "terminal.submit": GateAnswer;
    "terminal.keys": GateAnswer;
    "pane.close": GateAnswer;
    "tab.close": GateAnswer;
    "workspace.close": GateAnswer;
    "pane.split": GateAnswer;
    "tab.create": GateAnswer;
    "workspace.create": GateAnswer;
    "agent.start": GateAnswer;
    "worktree.create": GateAnswer;
    "worktree.remove": GateAnswer;
    "file.write": GateAnswer;
    "git.mutate": GateAnswer;
    "settings.change": GateAnswer;
    "update.install": GateAnswer;
    "extension.tool": GateAnswer;
  }

  export type Handler<N extends EventName> = (
    $: Dollar,
    event: Readonly<Events[N]>,
    next: Next<Events[N]>,
  ) => Awaitable<Answers[N]>;

  export type ToolHandler = (
    $: Dollar,
    event: Readonly<ToolEvent>,
    next: Next<ToolEvent>,
  ) => unknown;

  /** A handler matcher: fields of the event against values or regexes. */
  export type HandlerMatcherValue =
    | string
    | number
    | boolean
    | null
    | RegExp
    | HandlerMatcherValue[];
  export type HandlerMatcher = Record<string, HandlerMatcherValue>;

  export interface HandlerOptions {
    /** `block` makes a throwing gate deny instead of passing. */
    onFailure?: "continue" | "block";
  }

  /**
   * Subscribes a handler; matchers pick events by field. The event name alone
   * picks the handler's types, so answers keep their literal types.
   */
  export interface On {
    <N extends EventName>(
      event: N,
      handler: Handler<NoInfer<N>>,
      options?: HandlerOptions,
    ): void;
    <N extends EventName>(
      event: N,
      matcher: HandlerMatcher,
      handler: Handler<NoInfer<N>>,
      options?: HandlerOptions,
    ): void;
    (
      event: `tool.${string}`,
      handler: ToolHandler,
      options?: HandlerOptions,
    ): void;
    (
      event: `tool.${string}`,
      matcher: HandlerMatcher,
      handler: ToolHandler,
      options?: HandlerOptions,
    ): void;
  }

  /** The mod's `register` export (or default export). */
  export type Register = (on: On, $: Dollar) => void | Promise<void>;

  // The `$` API. Calls go to Roamgate and need the listed capability.

  /** A pane id on the event's connection, or a pane on a named one. */
  export type PaneTarget = string | { pane_id: string; connection?: string };

  export interface ProcessOptions {
    /** Absolute; the extension directory by default for local runs. */
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    /** Milliseconds; 30 s by default, at most 10 min. */
    timeout?: number;
    /** Runs over SSH on this connection (`process.remote`); not on Windows hosts. */
    connection?: string;
    /** With `connection`: the command only reads, so it may retry. */
    readOnly?: boolean;
  }

  export interface ProcessResult {
    code: number;
    stdout: string;
    stderr: string;
    /** Output went over 4 MiB and was cut. */
    truncated?: true;
  }

  export interface FetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Milliseconds; 30 s by default. */
    timeout?: number;
  }

  export interface FetchResult {
    status: number;
    ok: boolean;
    /** The final URL after redirects. */
    url: string;
    headers: Record<string, string>;
    body: string;
  }

  /** Which checkout and how content is encoded; the event's workspace by default. */
  export interface FileOptions {
    workspace_id?: string;
    /** The event's connection by default. */
    connection?: string;
    /** Reads pick `utf8` for UTF-8 text without NUL bytes, `base64` otherwise. */
    encoding?: "utf8" | "base64";
  }

  export interface FileReadResult {
    content: string;
    encoding: "utf8" | "base64";
    size: number;
  }

  export interface Ask {
    title: string;
    body?: string;
    detail?: string;
    risk?: "low" | "medium" | "high";
    timeout_ms?: number;
    on_timeout?: "deny" | "allow";
  }

  const clockTimer: unique symbol;
  export type ClockTimer = { readonly [clockTimer]: true };

  export interface Logger {
    debug(message: unknown, fields?: Record<string, unknown>): void;
    info(message: unknown, fields?: Record<string, unknown>): void;
    warn(message: unknown, fields?: Record<string, unknown>): void;
    error(message: unknown, fields?: Record<string, unknown>): void;
  }

  export interface Dollar {
    config: {
      /** Every setting; secrets only with `secrets`. */
      all(): Promise<Record<string, unknown>>;
      /** One setting, or null; secret settings need `secrets`. */
      get(key: string): Promise<unknown>;
    };
    /** JSON values kept across restarts, 16 MiB in total. */
    store: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
      keys(): Promise<string[]>;
    };
    /** In-memory state, lost when the mod stops. */
    state: Map<string, unknown>;
    /** Timers cleared when the mod stops. */
    clock: {
      now(): number;
      setTimeout(callback: () => void, ms: number): ClockTimer;
      clearTimeout(timer: ClockTimer): void;
      setInterval(callback: () => void, ms: number): ClockTimer;
      clearInterval(timer: ClockTimer): void;
    };
    /** Lines in the extension log; secrets are redacted. */
    log: Logger;
    /** `workspace.read`. */
    roamgate: {
      connections(): Promise<unknown[]>;
      workspaces(connection?: string): Promise<unknown>;
      tabs(
        params?: Record<string, unknown>,
        connection?: string,
      ): Promise<unknown>;
      panes(
        params?: Record<string, unknown>,
        connection?: string,
      ): Promise<unknown>;
      agents(connection?: string): Promise<unknown>;
    };
    herdr: {
      /** `herdr.read` for read methods, `herdr.write` (gated) otherwise. */
      call(
        connection: string | undefined,
        method: string,
        params?: Record<string, unknown>,
      ): Promise<unknown>;
    };
    terminal: {
      /** `terminal.write`; raises `terminal.submit`. */
      send(pane: PaneTarget, text: string): Promise<unknown>;
      /** `terminal.write`; raises `terminal.keys`. */
      keys(pane: PaneTarget, keys: string | string[]): Promise<unknown>;
      /** `terminal.read`. */
      screen(
        pane: PaneTarget,
        options?: { source?: string; lines?: number },
      ): Promise<unknown>;
    };
    /** `agent.sessions`. */
    agent: {
      session(pane: PaneTarget): Promise<unknown>;
      history(
        pane: PaneTarget,
        options?: Record<string, unknown>,
      ): Promise<unknown>;
    };
    notify: {
      /** `notifications`; raises `notify.send`. */
      push(message: {
        title: string;
        body?: string;
        target?: unknown;
      }): Promise<{ suppressed: boolean }>;
    };
    ui: {
      /** `ui`. */
      toast(toast: {
        kind?: ToastSlotData["kind"];
        message: string;
        detail?: string;
        command?: string;
      }): Promise<void>;
      /** `ui`: renders the slot (or every slot) again. */
      invalidate(slot?: Slot | (string & {})): Promise<void>;
      /** `gates`: waits for a person's answer. */
      ask(ask: Ask): Promise<{ approved: boolean; reason?: string }>;
    };
    events: {
      /** `ui`: sends an event to this extension's frames (256 KiB at most). */
      emit(
        name: string,
        data?: unknown,
        options?: { frame?: string },
      ): Promise<void>;
    };
    process: {
      /** `process`, or `process.remote` with `connection`. argv only, no shell. */
      run(argv: string[], options?: ProcessOptions): Promise<ProcessResult>;
    };
    http: {
      /** `network`: hosts in `network_hosts` only; 4 MiB bodies, 5 redirects. */
      fetch(url: string, init?: FetchInit): Promise<FetchResult>;
    };
    files: {
      /** `files.read`: a checkout-relative file, 5 MiB at most. */
      read(path: string, options?: FileOptions): Promise<FileReadResult>;
      /** `files.write`, raises `file.write`: creates or replaces a file in an existing directory. */
      write(
        path: string,
        content: string,
        options?: FileOptions,
      ): Promise<{ ok: true; size: number }>;
    };
  }

  // Only the declarations marked `export` are exported.
  export {};
}

declare module "roamgate:testing" {
  import type { EventBase, Gate, Manifest } from "roamgate";

  export interface FakeCall {
    ns: string;
    method: string;
    args: unknown[];
  }

  /** A stub's value, or a function of the call's arguments that returns it. */
  export type FakeStub = unknown;

  export interface FakeAsk {
    title: string;
    body?: string;
    detail?: string;
    risk?: "low" | "medium" | "high";
  }

  export type FakeAskAnswer =
    | "approve"
    | "deny"
    | ((ask: FakeAsk) => boolean | Promise<boolean>);

  export interface FakeHostOptions {
    /** The extension directory; the current directory by default. */
    dir?: string;
    /** Setting values over the manifest defaults, secrets included. */
    config?: Record<string, unknown>;
    store?: Record<string, unknown>;
    /** `ns.method` -> stubbed answer, e.g. `{"roamgate.agents": {agents: []}}`. */
    stubs?: Record<string, FakeStub>;
    /** How `$.ui.ask` is answered; deny by default. */
    asks?: FakeAskAnswer;
    /** The connection events carry; `null` for none. */
    connection?: { id: string; generation: number } | null;
  }

  export type FakeEvent = { name: string } & Record<string, unknown>;

  export interface FakeLog {
    level: "error" | "warn" | "info" | "debug";
    message: string;
    fields?: Record<string, unknown>;
  }

  export interface FakeOutcome {
    /** The event after accepted rewrites. */
    event: EventBase;
    /** The first handler answer; undefined when every handler passed. */
    answer?: unknown;
    /** Action events: the combined gate, deny > ask > allow. */
    gate?: Gate;
    /** Handler failures, in order. */
    errors: string[];
  }

  export interface FakeHost {
    readonly manifest: Manifest;
    /** Every `$` call, in order. */
    readonly calls: FakeCall[];
    readonly toasts: Record<string, unknown>[];
    readonly notifications: Record<string, unknown>[];
    readonly invalidations: Array<string | null>;
    readonly processes: Array<{ argv: unknown; options: unknown }>;
    readonly asks: FakeAsk[];
    readonly logs: FakeLog[];
    readonly store: Map<string, unknown>;
    /** Current setting values; edits apply to later `$.config` calls. */
    readonly config: Record<string, unknown>;
    stub(call: string, value: FakeStub): void;
    answerAsks(answer: FakeAskAnswer): void;
    /** Runs the mod's handlers for one event, as Roamgate's chain does. */
    emit(event: FakeEvent): Promise<FakeOutcome>;
    /** The combined Gate of an action event. */
    gate(event: FakeEvent): Promise<Gate>;
    /** The mod's `ui.render` answer for one slot entry. */
    render(
      slot: string,
      context?: Record<string, unknown>,
      entryId?: string,
    ): Promise<unknown>;
    /** Runs one of the manifest's commands and returns the mod's answer. */
    command(id: string, args?: unknown): Promise<unknown>;
    close(): Promise<void>;
  }

  /** Loads the extension in `options.dir` and runs its `register()`. */
  export function createFakeHost(options?: FakeHostOptions): Promise<FakeHost>;

  export {};
}
