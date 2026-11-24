import { type FSWatcher, watch } from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import {
  type ApiStabilityMarker,
  type ChildHandleResult,
  type ChildInitParams,
  type ChildInitResult,
  type ChildLogParams,
  describeDeprecation,
  EXTENSION_API_VERSION,
  type ExtensionApiStability,
  type ExtensionCapability,
  type ExtensionEventBase,
  type ExtensionLogLine,
  type ExtensionManifest,
  type ExtensionStateEntry,
  type ExtensionStateResult,
  eventStability,
  HANDLER_BUDGET_CEILING_MS,
  type HandlerRegistration,
  handlerBudgetMs,
  isActionEvent,
  matchesEvent,
  methodStability,
  REWRITABLE_FIELDS,
  REWRITE_TEXT_LIMITS,
  SUPPRESSIBLE_EVENTS,
} from "../../../shared/extensions";
import { ensureDataDirectory } from "../config/data-paths";
import { formatLogLine, type Logger } from "../utils/logger";
import {
  type CommandHooksOutcome,
  type CommandHookTarget,
  commandHookEvents,
  matchingCommandHooks,
  runCommandHooks,
} from "./command-hooks";
import {
  createDollarDispatcher,
  type DollarDispatcher,
  type DollarHost,
} from "./dollar";
import type {
  DispatchMode,
  DispatchOutcome,
  EventSubscriber,
  ExtensionBus,
} from "./events";
import {
  combineGates,
  type DecidedGate,
  extensionEnvironment,
  parseGate,
} from "./guard";
import { resolveKeybindings } from "./keybindings";
import type { ExtensionPaths } from "./paths";
import { JsonRpcPeer } from "./protocol";
import type { ExtensionRegistry, RegisteredExtension } from "./registry";
import { ExtensionStore } from "./store";

export const INIT_TIMEOUT_MS = 10_000;
export const IDLE_SHUTDOWN_MS = 10 * 60_000;
export const SHUTDOWN_GRACE_MS = 2_000;
/** Cancelled calls in a row with no word from the child before it is killed. */
export const UNRESPONSIVE_CANCEL_LIMIT = 3;
/** Time a cancelled handler gets to answer before it counts as unresponsive. */
export const CANCEL_GRACE_MS = 1_000;
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000];
/** Quiet time after the last change in a linked directory before it reloads. */
export const LINK_RELOAD_DEBOUNCE_MS = 150;
const LOG_FILE_MAX_BYTES = 1024 * 1024;
const LOG_RING_LINES = 1_000;

export interface ExtensionHostOptions {
  registry: ExtensionRegistry;
  paths: ExtensionPaths;
  bus: ExtensionBus;
  logger: Logger;
  /** The bridge services `$` reaches; the bus is filled in by the host. */
  dollar: Omit<DollarHost, "bus">;
  /** argv that starts this program; `__ext-host` and its flags follow. */
  hostCommand?: string[];
  /** Per-event own-time budgets, for tests and settings. */
  budgets?: Partial<Record<string, number>>;
  idleShutdownMs?: number;
  now?: () => number;
  /** The extension's settings for the mod and `$.config`; secret values only with `secrets`. */
  readConfig?: (
    id: string,
    connectionId?: string,
  ) => Promise<Record<string, unknown>>;
  /**
   * An extension's previous root stopped for good: its handlers drained after
   * an update, or it was removed. Installed version directories can go.
   */
  onRetired?: (id: string, root: string) => void;
  /** Watch linked directories and reload their extension on change. */
  watchLinks?: boolean;
  /** Stability markers to check against; tests replace them. */
  stability?: ExtensionApiStability;
}

/** The argv prefix of the running Roamgate: the binary, or Bun plus the entry. */
export function defaultHostCommand(): string[] {
  return Bun.isStandaloneExecutable
    ? [process.execPath]
    : [process.execPath, resolve(import.meta.dir, "../index.ts")];
}

type Registration = HandlerRegistration;

interface CallState {
  /** Own-time left once the current pause ends. */
  deadline: number;
  ceiling: number;
  pausedAt: number | null;
  pauses: number;
  scope: ExtensionEventBase;
  timer: ReturnType<typeof setTimeout> | undefined;
  expire: () => void;
}

interface Child {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  peer: JsonRpcPeer;
  registrations: Registration[];
  stopping: boolean;
  calls: Map<string, CallState>;
  unansweredCancels: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  inFlight: number;
  /** Resolved when inFlight drops to zero. */
  drainWaiters: Array<() => void>;
}

interface Runtime {
  id: string;
  manifest: ExtensionManifest;
  root: string;
  child: Child | null;
  activation: Promise<Child> | null;
  store: ExtensionStore;
  dollar: DollarDispatcher;
  logs: ExtensionLogLine[];
  crashes: number;
  restartAt: number;
  lastError?: { at: number; message: string };
  /** Pending writes to `logs/extension.log`, in order. */
  logFile: Promise<void>;
  /** Deprecated APIs already logged; each is logged once per run. */
  deprecationsLogged: Set<string>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Supervises one child process per active extension: lazy activation, handler
 * budgets, cancellation, kill, restart backoff and automatic disabling. It is
 * the bus subscriber that runs mod handlers in extension order.
 */
export class ExtensionHost implements EventSubscriber {
  private readonly runtimes = new Map<string, Runtime>();
  /** Event name -> extensions that want it, in order. */
  private interest = new Map<string, string[]>();
  /** Event name -> extensions with command hooks for it, in order. */
  private hookInterest = new Map<string, string[]>();
  private order: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly hostCommand: string[];
  private readonly now: () => number;
  private readonly dollarHost: DollarHost;
  private nextCallId = 1;
  private disposed = false;
  private readonly watchers = new Map<
    string,
    {
      root: string;
      watcher: FSWatcher;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();

  constructor(private readonly options: ExtensionHostOptions) {
    this.hostCommand = options.hostCommand ?? defaultHostCommand();
    this.now = options.now ?? Date.now;
    this.dollarHost = {
      config: options.readConfig,
      ...options.dollar,
      bus: options.bus,
    };
  }

  /** Loads the registry and activates startup extensions. Starts nothing in safe mode. */
  start(): void {
    this.sync();
    for (const id of this.order) {
      const runtime = this.runtimes.get(id);
      if (runtime?.manifest.activation.includes("startup"))
        void this.activate(runtime).catch(() => undefined);
    }
  }

  /** Re-reads registry state: stops removed or disabled extensions, indexes the rest. */
  sync(): void {
    const runnable = new Map<string, RegisteredExtension>();
    if (!this.options.registry.safeMode()) {
      for (const entry of this.options.registry.list()) {
        const { record, validation } = entry;
        if (
          record.enabled &&
          (validation.manifest?.mod ||
            commandHookEvents(validation.manifest?.hooks ?? []).length > 0) &&
          !validation.incompatible
        )
          runnable.set(record.id, entry);
      }
    }
    for (const [id, runtime] of this.runtimes) {
      const next = runnable.get(id);
      if (
        !next ||
        next.validation.root !== runtime.root ||
        next.validation.manifest?.version !== runtime.manifest.version
      ) {
        this.runtimes.delete(id);
        void this.retire(runtime, next ? "replaced" : "disabled");
      }
    }
    for (const [id, { validation }] of runnable) {
      if (this.runtimes.has(id) || !validation.manifest) continue;
      const store = new ExtensionStore(this.options.paths, id);
      this.runtimes.set(id, {
        id,
        manifest: validation.manifest,
        root: validation.root,
        child: null,
        activation: null,
        store,
        dollar: createDollarDispatcher({
          ext: id,
          manifest: validation.manifest,
          store,
          root: validation.root,
          host: this.dollarHost,
        }),
        logs: [],
        logFile: Promise.resolve(),
        deprecationsLogged: new Set(),
        crashes: 0,
        restartAt: 0,
      });
    }
    this.order = [...runnable.keys()];
    this.reindex();
    this.watchLinks();
    this.changed();
  }

  /**
   * Stops an extension's old root. After an update its in-flight handlers
   * finish first; the replacement already takes new events.
   */
  private async retire(runtime: Runtime, reason: string): Promise<void> {
    const child =
      runtime.child ?? (await runtime.activation?.catch(() => null));
    if (child && reason === "replaced") await this.drained(child);
    await this.stop(runtime, reason);
    this.options.onRetired?.(runtime.id, runtime.root);
  }

  private drained(child: Child): Promise<void> {
    if (child.inFlight === 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    child.drainWaiters.push(resolve);
    return promise;
  }

  /** Linked directories are watched; any change reloads the extension. */
  private watchLinks(): void {
    const wanted = new Map<string, string>();
    if (
      this.options.watchLinks &&
      !this.disposed &&
      !this.options.registry.safeMode()
    )
      for (const { record, validation } of this.options.registry.list())
        if (record.enabled && record.source.kind === "link")
          wanted.set(record.id, validation.root);
    for (const [id, entry] of this.watchers) {
      if (wanted.get(id) === entry.root) continue;
      clearTimeout(entry.timer);
      entry.watcher.close();
      this.watchers.delete(id);
    }
    for (const [id, root] of wanted) {
      if (this.watchers.has(id)) continue;
      let watcher: FSWatcher;
      try {
        watcher = watch(root, { recursive: true }, (_event, file) => {
          if (file && /(?:^|[\\/])(?:\.git|node_modules)(?:[\\/]|$)/.test(file))
            return;
          const entry = this.watchers.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            entry.timer = undefined;
            this.reload(id);
          }, LINK_RELOAD_DEBOUNCE_MS);
        });
      } catch (error) {
        this.options.logger.warn("cannot watch linked extension", {
          extension: id,
          error,
        });
        continue;
      }
      watcher.on("error", () => undefined);
      this.watchers.set(id, { root, watcher, timer: undefined });
    }
  }

  /**
   * Restarts one extension from its directory: the manifest and mod are read
   * again; `$.store` is on disk and survives. Browsers re-render its slots.
   */
  reload(id: string): void {
    if (this.disposed) return;
    const runtime = this.runtimes.get(id);
    const wasRunning = !!runtime?.child || !!runtime?.activation;
    if (runtime) {
      this.runtimes.delete(id);
      void this.stop(runtime, "reloaded");
    }
    this.options.registry.forget(id);
    this.sync();
    const next = this.runtimes.get(id);
    if (next && (wasRunning || next.manifest.activation.includes("startup")))
      void this.activate(next).catch(() => undefined);
    this.options.dollar.invalidate(id);
  }

  /** Delivers `config.change` to one extension after its settings changed. */
  async notifyConfigChange(id: string, keys: string[]): Promise<void> {
    if (!this.runtimes.has(id)) return;
    await this.runChain(
      [id],
      { name: "config.change", at: this.now(), keys },
      "observe",
      true,
    );
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wants(name: string): boolean {
    return this.interest.has(name) || this.hookInterest.has(name);
  }

  isRunning(id: string): boolean {
    return !!this.runtimes.get(id)?.child;
  }

  logs(id: string, limit = LOG_RING_LINES): ExtensionLogLine[] {
    return this.runtimes.get(id)?.logs.slice(-limit) ?? [];
  }

  state(): ExtensionStateResult {
    const safeMode = this.options.registry.safeMode();
    const listed = this.options.registry
      .list()
      .map(({ record, validation }) => {
        const manifest = validation.manifest;
        const status: ExtensionStateEntry["status"] = !manifest
          ? "invalid"
          : validation.incompatible
            ? "incompatible"
            : safeMode
              ? "safe_mode"
              : !record.enabled
                ? record.auto_disabled
                  ? "failed"
                  : "disabled"
                : this.runtimes.get(record.id)?.child
                  ? "active"
                  : "idle";
        return { record, validation, manifest, status };
      });
    const keybindings = resolveKeybindings(
      listed.flatMap(({ record, manifest, status }) =>
        manifest
          ? [
              {
                id: record.id,
                keybindings: manifest.keybindings,
                active: status === "active" || status === "idle",
              },
            ]
          : [],
      ),
    );
    const extensions = listed.map(
      ({ record, validation, manifest, status }): ExtensionStateEntry => {
        const lastFailure = record.failures.at(-1);
        return {
          id: record.id,
          name: manifest?.name ?? record.id,
          version: manifest?.version ?? record.version,
          status,
          enabled: record.enabled,
          capabilities: manifest?.capabilities ?? [],
          contributions: {
            commands: manifest?.commands ?? [],
            slots: manifest?.slots ?? [],
            keybindings: keybindings.get(record.id) ?? [],
            frames: manifest?.frames ?? [],
            themes: (manifest?.themes ?? []).map((theme) => ({
              ...theme,
              data: theme.data ?? {},
            })),
            link_patterns: manifest?.link_patterns ?? [],
            composer_commands: manifest?.composer_commands ?? [],
            previewers: manifest?.previewers ?? [],
          },
          ...(validation.errors.length || validation.incompatible
            ? {
                reason: validation.incompatible ?? validation.errors.join("; "),
              }
            : {}),
          ...(lastFailure
            ? { last_error: { at: lastFailure.at, message: lastFailure.error } }
            : {}),
        };
      },
    );
    return { safe_mode: safeMode, api: EXTENSION_API_VERSION, extensions };
  }

  async dispatch(
    event: ExtensionEventBase,
    mode: DispatchMode,
  ): Promise<DispatchOutcome> {
    const ids = this.interest.get(event.name) ?? [];
    const hooks = this.runCommandHooks(event, mode);
    if (!hooks) return this.runChain(ids, event, mode);
    // Command hooks run alongside the mod chain and see the event it got.
    const [chain, hooked] = await Promise.all([
      this.runChain(ids, event, mode),
      hooks,
    ]);
    let next = chain.event;
    for (const { ext, rewrite } of hooked.rewrites) {
      const runtime = this.runtimes.get(ext);
      if (runtime)
        next = this.applyRewrite(runtime, next, rewrite as ExtensionEventBase);
    }
    const gates = [chain.gate, hooked.gate].filter(
      (gate): gate is DecidedGate => !!gate,
    );
    const answer = chain.answer ?? hooked.answer;
    return {
      event: next,
      ...(answer ? { answer } : {}),
      ...(gates.length ? { gate: combineGates(gates) } : {}),
    };
  }

  /** Starts the command and url hooks matching `event`; null when none match. */
  private runCommandHooks(
    event: ExtensionEventBase,
    mode: DispatchMode,
  ): Promise<CommandHooksOutcome> | null {
    const owners = new Map<string, Runtime>();
    const targets: CommandHookTarget[] = [];
    for (const id of this.hookInterest.get(event.name) ?? []) {
      const runtime = this.runtimes.get(id);
      if (!runtime || event.origin === `extension:${id}`) continue;
      for (const hook of matchingCommandHooks(runtime.manifest.hooks, event)) {
        targets.push({
          ext: id,
          root: runtime.root,
          paths: this.options.paths,
          hook,
          networkHosts: runtime.manifest.network_hosts,
        });
        owners.set(id, runtime);
      }
    }
    if (targets.length === 0) return null;
    return runCommandHooks(targets, event, mode, {
      fail: (ext, message, policy) => {
        const runtime = owners.get(ext);
        return runtime ? this.fail(runtime, event, message, policy) : null;
      },
      log: (ext, message) => {
        const runtime = owners.get(ext);
        if (runtime) this.log(runtime, "info", message, "hook");
      },
    });
  }

  /** Runs one extension's `command.run` handlers, activating it on demand. */
  async runCommand(
    id: string,
    command: string,
    context: Record<string, unknown> = {},
  ): Promise<unknown> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`extension is not running: ${id}`);
    if (!runtime.manifest.commands.some((entry) => entry.id === command))
      throw new Error(`${id} has no command ${JSON.stringify(command)}`);
    const outcome = await this.runChain(
      [id],
      {
        ...context,
        name: "command.run",
        at: this.now(),
        command,
        args: context.args ?? null,
      },
      "answer",
      true,
    );
    return outcome.answer?.value ?? null;
  }

  /** Running extensions that contribute to `slot`, in order, with their manifests. */
  slotContributors(
    slot: string,
  ): Array<{ id: string; manifest: ExtensionManifest }> {
    const found: Array<{ id: string; manifest: ExtensionManifest }> = [];
    for (const id of this.order) {
      const runtime = this.runtimes.get(id);
      if (!runtime) continue;
      const { manifest } = runtime;
      if (
        manifest.activation.includes(`slot:${slot}`) ||
        manifest.slots.some((entry) => entry.slot === slot)
      )
        found.push({ id, manifest });
    }
    return found;
  }

  /**
   * Runnable extensions that declare `capability`, in order. The manifest
   * object is replaced on reload or update, so it keys per-version caches.
   */
  withCapability(
    capability: ExtensionCapability,
  ): Array<{ id: string; manifest: ExtensionManifest }> {
    const found: Array<{ id: string; manifest: ExtensionManifest }> = [];
    for (const id of this.order) {
      const manifest = this.runtimes.get(id)?.manifest;
      if (manifest?.capabilities.includes(capability))
        found.push({ id, manifest });
    }
    return found;
  }

  /**
   * Runs one extension's handlers for `event` (`ui.render`, `ui.action`),
   * activating it on demand. Resolves with its answer, or an error when a
   * handler failed or nothing answered with a failure. `unanswered` marks a
   * null that no handler returned, so callers can keep their defaults.
   */
  async answerOne(
    id: string,
    event: ExtensionEventBase,
  ): Promise<{ value: unknown; unanswered?: true } | { error: string }> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return { error: `extension is not running: ${id}` };
    const before = runtime.lastError;
    const outcome = await this.runChain([id], event, "answer", true);
    if (outcome.answer) return { value: outcome.answer.value };
    const latest = this.runtimes.get(id)?.lastError ?? runtime.lastError;
    if (latest && latest !== before) return { error: latest.message };
    return { value: null, unanswered: true };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.interest = new Map();
    this.hookInterest = new Map();
    for (const entry of this.watchers.values()) {
      clearTimeout(entry.timer);
      entry.watcher.close();
    }
    this.watchers.clear();
    await Promise.all(
      [...this.runtimes.values()].map((runtime) =>
        this.stop(runtime, "shutdown"),
      ),
    );
    this.runtimes.clear();
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.options.logger.warn("extension state listener failed", { error });
      }
    }
  }

  private reindex(): void {
    const interest = new Map<string, string[]>();
    const hookInterest = new Map<string, string[]>();
    const add = (event: string, id: string) => {
      const ids = interest.get(event) ?? [];
      if (!ids.includes(id)) ids.push(id);
      interest.set(event, ids);
    };
    for (const id of this.order) {
      const runtime = this.runtimes.get(id);
      if (!runtime) continue;
      for (const trigger of runtime.manifest.activation)
        if (trigger.startsWith("event:")) add(trigger.slice(6), id);
      for (const registration of runtime.child?.registrations ?? [])
        if (registration.event !== "command.run") add(registration.event, id);
      for (const name of commandHookEvents(runtime.manifest.hooks)) {
        const ids = hookInterest.get(name) ?? [];
        ids.push(id);
        hookInterest.set(name, ids);
      }
    }
    this.interest = interest;
    this.hookInterest = hookInterest;
  }

  private async runChain(
    ids: readonly string[],
    initial: ExtensionEventBase,
    mode: DispatchMode,
    includeSelf = false,
  ): Promise<DispatchOutcome> {
    let event = initial;
    const gates: DecidedGate[] = [];
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      // Hook-only extensions have no mod to run.
      if (!runtime?.manifest.mod) continue;
      // An extension's own actions never reach its own handlers.
      if (!includeSelf && event.origin === `extension:${id}`) continue;
      const budget = this.budget(event.name);
      let child: Child;
      try {
        child = await this.activateWithin(runtime, budget);
      } catch (error) {
        // A render outlived by cold start keeps the static entry; the mod
        // goes on starting and answers the next render.
        if (error instanceof ActivationTimeout && event.name === "ui.render") {
          this.log(runtime, "info", `ui.render: ${error.message}, kept static`);
          continue;
        }
        const failure = this.fail(runtime, event, errorText(error), "block");
        if (failure) return { event, ...failure };
        continue;
      }
      for (const registration of child.registrations) {
        if (registration.event !== event.name) continue;
        if (!matchesEvent(registration.matcher, event)) continue;
        const result = await this.callHandler(
          runtime,
          child,
          registration,
          event,
          budget,
        );
        if (result.kind === "error") {
          const failure = this.fail(
            runtime,
            event,
            result.message,
            registration.on_failure,
          );
          if (failure) return { event, ...failure };
          continue;
        }
        if (result.kind === "next") {
          if (result.payload)
            event = this.applyRewrite(runtime, event, result.payload);
          continue;
        }
        if (mode === "observe") continue;
        if (mode === "answer")
          return { event, answer: { ext: id, value: result.value } };
        let gate: DecidedGate;
        try {
          gate = parseGate(result.value, id);
        } catch (error) {
          const failure = this.fail(
            runtime,
            event,
            errorText(error),
            registration.on_failure,
          );
          if (failure) return { event, ...failure };
          continue;
        }
        gates.push(gate);
        if (gate.decision === "deny") return { event, gate };
      }
    }
    if (mode === "gate" && gates.length > 0) {
      const ask = gates.find((gate) => gate.decision === "ask");
      return { event, gate: ask ?? { decision: "allow" } };
    }
    return { event };
  }

  /** Records a failure; under a blocking policy returns how the event resolves. */
  private fail(
    runtime: Runtime,
    event: ExtensionEventBase,
    message: string,
    policy: "continue" | "block",
  ): Pick<DispatchOutcome, "gate" | "answer"> | null {
    runtime.lastError = { at: this.now(), message };
    this.log(runtime, "error", `${event.name} handler failed: ${message}`);
    if (this.options.registry.recordFailure(runtime.id, message)) {
      this.options.logger.warn("extension disabled after repeated failures", {
        extension: runtime.id,
        error: message,
      });
      void this.stop(runtime, "auto-disabled");
      this.runtimes.delete(runtime.id);
      this.order = this.order.filter((id) => id !== runtime.id);
      this.reindex();
    }
    this.changed();
    if (policy !== "block") return null;
    if (isActionEvent(event.name) || event.name === "rpc.call")
      return {
        gate: { decision: "deny", reason: "extension error", ext: runtime.id },
      };
    if (SUPPRESSIBLE_EVENTS.has(event.name))
      return { answer: { ext: runtime.id, value: { suppress: true } } };
    return null;
  }

  private applyRewrite(
    runtime: Runtime,
    event: ExtensionEventBase,
    payload: ExtensionEventBase,
  ): ExtensionEventBase {
    const allowed = REWRITABLE_FIELDS[event.name] ?? [];
    const next: ExtensionEventBase = { ...event };
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(payload)) {
      if (Object.is(value, event[key])) continue;
      if (
        allowed.includes(key) &&
        (value === undefined ||
          typeof value === "string" ||
          (key === "params" &&
            !!value &&
            typeof value === "object" &&
            !Array.isArray(value)))
      )
        next[key] = value;
      else if (JSON.stringify(value) !== JSON.stringify(event[key]))
        dropped.push(key);
    }
    if (dropped.length)
      this.log(
        runtime,
        "warn",
        `${event.name}: ignored changes to ${dropped.join(", ")}`,
      );
    const changed = allowed.filter((key) => next[key] !== event[key]);
    const oversized = changed.filter(
      (key) =>
        typeof next[key] === "string" &&
        (next[key] as string).length > (REWRITE_TEXT_LIMITS[key] ?? Infinity),
    );
    if (oversized.length) {
      // The original event goes on unchanged rather than a cut-off rewrite.
      this.log(
        runtime,
        "error",
        `${event.name}: rewrite rejected, ${oversized
          .map((key) => `${key} is over ${REWRITE_TEXT_LIMITS[key]} characters`)
          .join(", ")}`,
      );
      return event;
    }
    if (changed.length)
      this.log(runtime, "info", `${event.name}: rewrote ${changed.join(", ")}`);
    return next;
  }

  private budget(event: string): number {
    return Math.min(
      this.options.budgets?.[event] ?? handlerBudgetMs(event),
      HANDLER_BUDGET_CEILING_MS,
    );
  }

  /** An event waits for activation up to its handler budget. */
  private activateWithin(runtime: Runtime, budgetMs: number): Promise<Child> {
    if (runtime.child) return Promise.resolve(runtime.child);
    const activation = this.activate(runtime);
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => timeout.reject(new ActivationTimeout(budgetMs)),
      budgetMs,
    );
    return Promise.race([activation, timeout.promise]).finally(() =>
      clearTimeout(timer),
    );
  }

  private activate(runtime: Runtime): Promise<Child> {
    if (runtime.child) return Promise.resolve(runtime.child);
    if (runtime.activation) return runtime.activation;
    if (this.disposed)
      return Promise.reject(new Error("extension host stopped"));
    const wait = runtime.restartAt - this.now();
    if (wait > 0)
      return Promise.reject(
        new Error(`restarting after a crash in ${Math.ceil(wait / 1000)}s`),
      );
    runtime.activation = this.spawn(runtime).finally(() => {
      runtime.activation = null;
    });
    return runtime.activation;
  }

  private async spawn(runtime: Runtime): Promise<Child> {
    const { paths } = this.options;
    const data = paths.dataDir(runtime.id);
    ensureDataDirectory(paths.root, data);
    const argv = [
      ...this.hostCommand,
      "__ext-host",
      "--root",
      runtime.root,
      "--id",
      runtime.id,
      "--api",
      EXTENSION_API_VERSION,
    ];
    const proc = Bun.spawn(argv, {
      cwd: runtime.root,
      env: extensionEnvironment(process.env, {
        ROAMGATE_EXTENSION_ID: runtime.id,
        ROAMGATE_EXTENSION_ROOT: runtime.root,
        ROAMGATE_EXTENSION_DATA: data,
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const child: Child = {
      proc,
      peer: new JsonRpcPeer({
        write: (line) => {
          proc.stdin.write(line);
          proc.stdin.flush();
        },
        onRequest: (method, params) =>
          this.childRequest(runtime, child, method, params),
        onNotification: (method, params) =>
          this.childNotification(runtime, child, method, params),
        onProtocolError: (error) => {
          this.log(runtime, "error", `protocol error: ${error.message}`);
          this.kill(runtime, child);
        },
      }),
      registrations: [],
      stopping: false,
      calls: new Map(),
      unansweredCancels: 0,
      idleTimer: undefined,
      inFlight: 0,
      drainWaiters: [],
    };
    void this.pump(proc.stdout, (chunk) => {
      child.unansweredCancels = 0;
      child.peer.receive(chunk);
    });
    void this.pumpLines(proc.stderr, (line) =>
      this.log(runtime, "info", line, "stderr"),
    );
    void proc.exited.then((code) => this.exited(runtime, child, code));
    try {
      const init = (await child.peer.request(
        "init",
        {
          id: runtime.id,
          root: runtime.root,
          data,
          api: EXTENSION_API_VERSION,
          config: (await this.options.readConfig?.(runtime.id)) ?? {},
          platform: process.platform,
          mod: resolve(runtime.root, runtime.manifest.mod ?? ""),
        } satisfies ChildInitParams,
        INIT_TIMEOUT_MS,
      )) as ChildInitResult;
      child.registrations = Array.isArray(init?.registrations)
        ? init.registrations
        : [];
      for (const registration of child.registrations)
        this.logDeprecated(
          runtime,
          registration.event,
          eventStability(registration.event, this.options.stability),
        );
    } catch (error) {
      this.kill(runtime, child);
      throw new Error(`activation failed: ${errorText(error)}`, {
        cause: error,
      });
    }
    if (this.disposed || this.runtimes.get(runtime.id) !== runtime) {
      this.kill(runtime, child);
      throw new Error("extension stopped while activating");
    }
    runtime.child = child;
    runtime.crashes = 0;
    this.log(runtime, "info", `activated (pid ${proc.pid})`);
    this.reindex();
    this.armIdle(runtime, child);
    this.changed();
    this.options.bus.emit({ name: "extension.activate", ext: runtime.id });
    return child;
  }

  private async pump(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<void> {
    try {
      for await (const chunk of stream) onChunk(chunk);
    } catch {
      // The child is gone; exited() reports it.
    }
  }

  private async pumpLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    await this.pump(stream, (chunk) => {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = (lines.pop() ?? "").slice(-8_192);
      for (const line of lines) if (line.trim()) onLine(line);
    });
    if (pending.trim()) onLine(pending);
  }

  private exited(runtime: Runtime, child: Child, code: number | null): void {
    clearTimeout(child.idleTimer);
    for (const call of child.calls.values()) clearTimeout(call.timer);
    // Calls cut short by the exit record the failure themselves.
    const countedByCalls = child.calls.size > 0;
    child.peer.close(new Error(`extension process exited (${code})`));
    if (runtime.child === child) runtime.child = null;
    if (!child.stopping) {
      const message = `extension process exited unexpectedly (code ${code})`;
      runtime.lastError = { at: this.now(), message };
      this.log(runtime, "error", message);
      runtime.restartAt =
        this.now() +
        (RESTART_BACKOFF_MS[
          Math.min(runtime.crashes, RESTART_BACKOFF_MS.length - 1)
        ] ?? 0);
      runtime.crashes++;
      if (
        !countedByCalls &&
        this.options.registry.recordFailure(runtime.id, message)
      ) {
        this.runtimes.delete(runtime.id);
        this.order = this.order.filter((id) => id !== runtime.id);
      } else if (
        !this.disposed &&
        runtime.manifest.activation.includes("startup") &&
        this.runtimes.get(runtime.id) === runtime
      ) {
        const timer = setTimeout(
          () => void this.activate(runtime).catch(() => undefined),
          Math.max(0, runtime.restartAt - this.now()),
        );
        timer.unref?.();
      }
    }
    this.reindex();
    this.changed();
    if (!this.disposed)
      this.options.bus.emit({ name: "extension.deactivate", ext: runtime.id });
  }

  private kill(runtime: Runtime, child: Child): void {
    child.stopping = true;
    try {
      child.proc.kill("SIGKILL");
    } catch {}
    if (runtime.child === child) runtime.child = null;
  }

  private async stop(runtime: Runtime, reason: string): Promise<void> {
    const child =
      runtime.child ?? (await runtime.activation?.catch(() => null));
    if (!child) return;
    child.stopping = true;
    runtime.child = null;
    for (const [callId, call] of child.calls) {
      clearTimeout(call.timer);
      child.peer.notify("cancel", { call_id: callId, reason });
    }
    await child.peer
      .request("shutdown", {}, SHUTDOWN_GRACE_MS)
      .catch(() => undefined);
    const exited = await Promise.race([
      child.proc.exited.then(() => true),
      Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!exited) this.kill(runtime, child);
    this.log(runtime, "info", `stopped (${reason})`);
  }

  private armIdle(runtime: Runtime, child: Child): void {
    clearTimeout(child.idleTimer);
    if (runtime.manifest.activation.includes("startup") || child.inFlight > 0)
      return;
    child.idleTimer = setTimeout(() => {
      if (runtime.child === child && child.inFlight === 0) {
        void this.stop(runtime, "idle").then(() => {
          this.reindex();
          this.changed();
        });
      }
    }, this.options.idleShutdownMs ?? IDLE_SHUTDOWN_MS);
    child.idleTimer.unref?.();
  }

  /**
   * One handler call under its budget. Time the bridge spends serving the
   * call's `$` requests does not count, up to the hard ceiling.
   */
  private callHandler(
    runtime: Runtime,
    child: Child,
    registration: Registration,
    event: ExtensionEventBase,
    budgetMs: number,
  ): Promise<ChildHandleResult> {
    const callId = `c${this.nextCallId++}`;
    const done = Promise.withResolvers<ChildHandleResult>();
    const started = this.now();
    const call: CallState = {
      deadline: started + budgetMs,
      ceiling: started + HANDLER_BUDGET_CEILING_MS,
      pausedAt: null,
      pauses: 0,
      scope: event,
      timer: undefined,
      expire: () => {
        if (!child.calls.delete(callId)) return;
        child.peer.notify("cancel", {
          call_id: callId,
          reason: "budget exceeded",
        });
        done.resolve({
          kind: "error",
          message: `handler exceeded its ${budgetMs}ms budget`,
        });
        this.watchCancelled(runtime, child, () => answered);
      },
    };
    child.calls.set(callId, call);
    child.inFlight++;
    clearTimeout(child.idleTimer);
    this.schedule(call);
    let answered = false;
    child.peer
      .request("handle", {
        call_id: callId,
        handler_id: registration.handler_id,
        event: event.name,
        payload: event,
      })
      .then(
        (result) => {
          answered = true;
          child.unansweredCancels = 0;
          if (!child.calls.delete(callId)) return;
          clearTimeout(call.timer);
          done.resolve(this.handleResult(result));
        },
        (error) => {
          answered = true;
          if (!child.calls.delete(callId)) return;
          clearTimeout(call.timer);
          done.resolve({ kind: "error", message: errorText(error) });
        },
      );
    return done.promise.finally(() => {
      child.inFlight--;
      if (child.inFlight === 0)
        for (const resolve of child.drainWaiters.splice(0)) resolve();
      if (runtime.child === child) this.armIdle(runtime, child);
    });
  }

  private handleResult(value: unknown): ChildHandleResult {
    const result = value as Partial<ChildHandleResult> | null;
    if (result?.kind === "next")
      return result.payload && typeof result.payload === "object"
        ? { kind: "next", payload: result.payload }
        : { kind: "next" };
    if (result?.kind === "answer")
      return { kind: "answer", value: result.value };
    if (result?.kind === "error")
      return { kind: "error", message: String(result.message ?? "error") };
    return { kind: "error", message: "invalid handler result" };
  }

  /** A cancelled call that never answers counts towards killing a stuck child. */
  private watchCancelled(
    runtime: Runtime,
    child: Child,
    answered: () => boolean,
  ): void {
    const timer = setTimeout(() => {
      if (answered() || child.stopping) return;
      // Any message from the child resets the count; a busy loop sends none.
      child.unansweredCancels++;
      if (child.unansweredCancels >= UNRESPONSIVE_CANCEL_LIMIT) {
        this.log(runtime, "error", "killed: handlers ignored cancellation");
        this.kill(runtime, child);
      }
    }, CANCEL_GRACE_MS);
    timer.unref?.();
  }

  private schedule(call: CallState): void {
    clearTimeout(call.timer);
    if (call.pausedAt !== null) {
      call.timer = setTimeout(
        call.expire,
        Math.max(0, call.ceiling - this.now()),
      );
      return;
    }
    call.timer = setTimeout(
      call.expire,
      Math.max(0, Math.min(call.deadline, call.ceiling) - this.now()),
    );
  }

  private pause(child: Child, callId: unknown): void {
    const call =
      typeof callId === "string" ? child.calls.get(callId) : undefined;
    if (!call) return;
    if (call.pauses++ === 0) {
      call.pausedAt = this.now();
      this.schedule(call);
    }
  }

  private resume(child: Child, callId: unknown): void {
    const call =
      typeof callId === "string" ? child.calls.get(callId) : undefined;
    if (!call || call.pauses === 0) return;
    if (--call.pauses === 0 && call.pausedAt !== null) {
      call.deadline += this.now() - call.pausedAt;
      call.pausedAt = null;
      this.schedule(call);
    }
  }

  /** Logs each deprecated API an extension uses, once per run. */
  private logDeprecated(
    runtime: Runtime,
    api: string,
    marker: ApiStabilityMarker | undefined,
  ): void {
    if (
      marker?.stability !== "deprecated" ||
      runtime.deprecationsLogged.has(api)
    )
      return;
    runtime.deprecationsLogged.add(api);
    this.log(runtime, "warn", describeDeprecation(api, marker));
  }

  private childRequest(
    runtime: Runtime,
    child: Child,
    method: string,
    params: unknown,
  ): unknown {
    const value = (params ?? {}) as Record<string, unknown>;
    if (method === "$") {
      const callId = value.call_id;
      const scope =
        typeof callId === "string" ? child.calls.get(callId)?.scope : undefined;
      this.pause(child, callId);
      if (typeof value.ns === "string" && typeof value.method === "string") {
        const call = `${value.ns}.${value.method}`;
        this.logDeprecated(
          runtime,
          `$.${call}`,
          methodStability(call, this.options.stability),
        );
      }
      return runtime.dollar
        .call(
          value.ns as string,
          value.method as string,
          value.args as unknown[],
          scope
            ? { connection: scope.connection, workspace_id: scope.workspace_id }
            : undefined,
        )
        .finally(() => this.resume(child, callId));
    }
    if (method === "register") {
      const registration = value as unknown as Registration;
      if (
        typeof registration.event !== "string" ||
        typeof registration.handler_id !== "string"
      )
        throw new Error("register needs an event and handler id");
      child.registrations.push({
        handler_id: registration.handler_id,
        event: registration.event,
        matcher: registration.matcher,
        on_failure: registration.on_failure === "block" ? "block" : "continue",
      });
      this.logDeprecated(
        runtime,
        registration.event,
        eventStability(registration.event, this.options.stability),
      );
      this.reindex();
      return { handler_id: registration.handler_id };
    }
    throw new Error(`unknown method: ${method}`);
  }

  private childNotification(
    runtime: Runtime,
    child: Child,
    method: string,
    params: unknown,
  ): void {
    const value = (params ?? {}) as Record<string, unknown>;
    if (method === "log") {
      const { level, message, fields } = value as Partial<ChildLogParams>;
      this.log(
        runtime,
        level === "error" || level === "warn" || level === "debug"
          ? level
          : "info",
        String(message ?? ""),
        undefined,
        fields && typeof fields === "object" ? fields : undefined,
      );
    } else if (method === "budget.pause") this.pause(child, value.call_id);
    else if (method === "budget.resume") this.resume(child, value.call_id);
  }

  /** Redacted, bounded per-extension log, mirrored to the service log. */
  private log(
    runtime: Runtime,
    level: ChildLogParams["level"],
    message: string,
    source?: string,
    fields?: Record<string, unknown>,
  ): void {
    const at = this.now();
    const line = formatLogLine({
      timestamp: new Date(at),
      level,
      scope: source ? `ext.${runtime.id}.${source}` : `ext.${runtime.id}`,
      message,
      fields,
    });
    runtime.logs.push({ at, level, line });
    if (runtime.logs.length > LOG_RING_LINES)
      runtime.logs.splice(0, runtime.logs.length - LOG_RING_LINES);
    this.appendLogFile(runtime, line);
    const logger = this.options.logger.child(`ext.${runtime.id}`);
    logger[level === "error" || level === "warn" ? level : "debug"](
      message,
      fields,
    );
  }

  /** `logs/extension.log` for `roamgate ext logs`; rotated once past 1 MiB. */
  private appendLogFile(runtime: Runtime, line: string): void {
    const { paths } = this.options;
    const dir = paths.logsDir(runtime.id);
    const file = `${dir}/extension.log`;
    runtime.logFile = runtime.logFile
      .then(async () => {
        ensureDataDirectory(paths.root, dir);
        const size = await stat(file).then(
          (info) => info.size,
          () => 0,
        );
        if (size > LOG_FILE_MAX_BYTES) await rename(file, `${file}.1`);
        await appendFile(file, `${line}\n`, { mode: 0o600 });
      })
      .catch(() => undefined);
  }
}

/** Activation outlasted an event's budget; the activation itself goes on. */
class ActivationTimeout extends Error {
  constructor(budgetMs: number) {
    super(`activation took longer than ${budgetMs}ms`);
  }
}
