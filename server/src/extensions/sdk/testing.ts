import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ChildHandleResult,
  type ChildLogParams,
  type DollarCallParams,
  EXTENSION_API_VERSION,
  EXTENSION_RPC_ERRORS,
  type ExtensionEventBase,
  type ExtensionManifest,
  type Gate,
  type HandlerRegistration,
  isActionEvent,
  matchesEvent,
  REWRITABLE_FIELDS,
  SUPPRESSIBLE_EVENTS,
} from "../../../../shared/extensions";
import { missingCapabilities } from "../analyze";
import {
  assertDollarCallAllowed,
  combineGates,
  type DecidedGate,
  parseGate,
} from "../guard";
import { validateExtensionDir } from "../manifest";
import { ExtensionRpcError, JsonRpcPeer } from "../protocol";
import { createExtensionChild } from "./runtime";

/**
 * The fake host behind `roamgate ext test`, imported as `roamgate:testing`.
 * It runs the mod through the real extension runtime in-process and answers
 * its `$` calls from memory: capabilities are enforced as in Roamgate, ui,
 * notify, ask and process calls are recorded, and herdr, roamgate and other
 * bridge calls answer from stubs.
 */

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

export interface FakeOutcome {
  /** The event after accepted rewrites. */
  event: ExtensionEventBase;
  /** The first handler answer; undefined when every handler passed. */
  answer?: unknown;
  /** Action events: the combined gate, deny > ask > allow. */
  gate?: Gate;
  /** Handler failures, in order. */
  errors: string[];
}

export interface FakeHost {
  readonly manifest: ExtensionManifest;
  /** Every `$` call, in order. */
  readonly calls: FakeCall[];
  readonly toasts: Record<string, unknown>[];
  readonly notifications: Record<string, unknown>[];
  readonly invalidations: Array<string | null>;
  readonly processes: Array<{ argv: unknown; options: unknown }>;
  readonly asks: FakeAsk[];
  readonly logs: ChildLogParams[];
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function capabilityError(ext: string, call: string, capability: string) {
  return new ExtensionRpcError(
    EXTENSION_RPC_ERRORS.capability,
    `${call} needs the "${capability}" capability, which ${ext} does not declare`,
  );
}

/** Tests compare plain gates; the owning extension is implied. */
function withoutOwner(gate: DecidedGate): Gate {
  const plain = { ...gate };
  delete plain.ext;
  return plain;
}

/** Loads the extension in `options.dir` and runs its `register()`. */
export async function createFakeHost(
  options: FakeHostOptions = {},
): Promise<FakeHost> {
  const validation = validateExtensionDir(options.dir ?? process.cwd(), {
    appVersion: "0.0.0",
  });
  if (!validation.manifest)
    throw new Error(
      `invalid extension in ${validation.root}:\n${validation.errors.join("\n")}`,
    );
  const manifest: ExtensionManifest = validation.manifest;
  if (!manifest.mod) throw new Error(`${manifest.id} has no mod`);
  for (const key of Object.keys(options.config ?? {}))
    if (!manifest.config[key])
      throw new Error(`${manifest.id} has no setting ${key}`);

  const capabilities = manifest.capabilities as readonly string[];
  const calls: FakeCall[] = [];
  const toasts: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const invalidations: Array<string | null> = [];
  const processes: Array<{ argv: unknown; options: unknown }> = [];
  const asks: FakeAsk[] = [];
  const logs: ChildLogParams[] = [];
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}));
  const stubs = new Map<string, FakeStub>(Object.entries(options.stubs ?? {}));
  const config: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(manifest.config))
    config[key] = setting.default ?? null;
  Object.assign(config, options.config);
  let askAnswer: FakeAskAnswer = options.asks ?? "deny";
  const connection =
    options.connection === undefined
      ? { id: "local", generation: 1 }
      : options.connection;
  const registrations: HandlerRegistration[] = [];
  const data = mkdtempSync(join(tmpdir(), "roamgate-ext-test-"));
  let nextCall = 1;

  /** What the mod sees: secret values only with the `secrets` capability. */
  const configView = () => {
    const view: Record<string, unknown> = {};
    for (const [key, setting] of Object.entries(manifest.config)) {
      const value = config[key] ?? null;
      view[key] =
        setting.type === "secret" && !capabilities.includes("secrets")
          ? { set: value !== null }
          : value;
    }
    return view;
  };

  const storeKey = (key: unknown) => {
    if (typeof key !== "string" || !key)
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.invalidParams,
        "store keys are non-empty strings",
      );
    return key;
  };

  async function dollar(params: DollarCallParams): Promise<unknown> {
    const { ns, method } = params;
    const args = Array.isArray(params.args) ? params.args : [];
    const name = `${ns}.${method}`;
    const call = { ns, method, args };
    calls.push(call);
    assertDollarCallAllowed(ns, method);
    const missing = missingCapabilities(name, capabilities);
    if (missing)
      throw capabilityError(manifest.id, `$.${name}`, missing.join('" or "'));
    switch (name) {
      case "config.all":
        return configView();
      case "config.get": {
        const key = String(args[0]);
        if (
          manifest.config[key]?.type === "secret" &&
          !capabilities.includes("secrets")
        )
          throw capabilityError(
            manifest.id,
            `$.config.get(${JSON.stringify(key)})`,
            "secrets",
          );
        return configView()[key] ?? null;
      }
      case "store.get":
        return store.get(storeKey(args[0])) ?? null;
      case "store.set":
        store.set(storeKey(args[0]), structuredClone(args[1]));
        return null;
      case "store.delete":
        return store.delete(storeKey(args[0]));
      case "store.keys":
        return [...store.keys()];
    }
    if (stubs.has(name)) {
      const stub = stubs.get(name);
      return typeof stub === "function" ? stub(args, call) : stub;
    }
    switch (name) {
      case "ui.toast":
        toasts.push(record(args[0]));
        return null;
      case "ui.invalidate":
        invalidations.push(typeof args[0] === "string" ? args[0] : null);
        return null;
      case "notify.push":
        notifications.push(record(args[0]));
        return { suppressed: false };
      case "ui.ask": {
        const ask = record(args[0]) as unknown as FakeAsk;
        asks.push(ask);
        const approved =
          typeof askAnswer === "function"
            ? await askAnswer(ask)
            : askAnswer === "approve";
        return approved
          ? { approved: true }
          : { approved: false, reason: "denied by the fake host" };
      }
      case "process.run":
        processes.push({ argv: args[0], options: args[1] ?? {} });
        return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(
      `$.${name} has no stub in the fake host; add one with host.stub(${JSON.stringify(name)}, value)`,
    );
  }

  const child = createExtensionChild((line) =>
    queueMicrotask(() => bridge.receive(line)),
  );
  const bridge: JsonRpcPeer = new JsonRpcPeer({
    write: (line) => queueMicrotask(() => child.peer.receive(line)),
    onRequest: (method, params) => {
      if (method === "$") return dollar(params as DollarCallParams);
      if (method === "register") {
        registrations.push(params as HandlerRegistration);
        return { handler_id: (params as HandlerRegistration).handler_id };
      }
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.methodNotFound,
        `unknown method: ${method}`,
      );
    },
    onNotification: (method, params) => {
      if (method === "log") logs.push(params as ChildLogParams);
    },
  });

  try {
    const init = (await bridge.request("init", {
      id: manifest.id,
      root: validation.root,
      data,
      api: EXTENSION_API_VERSION,
      config: configView(),
      platform: process.platform,
      mod: resolve(validation.root, manifest.mod),
    })) as { registrations?: HandlerRegistration[] };
    registrations.push(...(init.registrations ?? []));
  } catch (error) {
    rmSync(data, { recursive: true, force: true });
    throw error;
  }

  function rewrite(
    event: ExtensionEventBase,
    payload: ExtensionEventBase,
  ): ExtensionEventBase {
    const next = { ...event };
    for (const key of REWRITABLE_FIELDS[event.name] ?? []) {
      if (!(key in payload)) continue;
      const value = payload[key];
      if (
        value === undefined ||
        typeof value === "string" ||
        (key === "params" && record(value) === value)
      )
        next[key] = value;
    }
    return next;
  }

  async function emit(input: FakeEvent): Promise<FakeOutcome> {
    let event: ExtensionEventBase = {
      at: Date.now(),
      origin: "browser",
      ...(connection ? { connection } : {}),
      ...input,
    };
    const gating = isActionEvent(event.name) || event.name === "rpc.call";
    const gates: DecidedGate[] = [];
    const errors: string[] = [];
    for (const registration of registrations) {
      if (registration.event !== event.name) continue;
      if (!matchesEvent(registration.matcher, event)) continue;
      const result = (await bridge.request("handle", {
        call_id: `c${nextCall++}`,
        handler_id: registration.handler_id,
        event: event.name,
        payload: event,
      })) as ChildHandleResult;
      let failure: string;
      if (result.kind === "next") {
        if (result.payload) event = rewrite(event, result.payload);
        continue;
      }
      if (result.kind === "error") failure = result.message;
      else if (!gating) return { event, answer: result.value, errors };
      else {
        try {
          const gate = parseGate(result.value, manifest.id);
          if (gate.decision === "deny")
            return { event, gate: withoutOwner(gate), errors };
          gates.push(gate);
          continue;
        } catch (error) {
          failure = (error as Error).message;
        }
      }
      errors.push(`${event.name} handler failed: ${failure}`);
      if (registration.on_failure !== "block") continue;
      if (gating)
        return {
          event,
          gate: { decision: "deny", reason: "extension error" },
          errors,
        };
      if (SUPPRESSIBLE_EVENTS.has(event.name))
        return { event, answer: { suppress: true }, errors };
    }
    return gating
      ? { event, gate: withoutOwner(combineGates(gates)), errors }
      : { event, errors };
  }

  async function answer(event: FakeEvent): Promise<unknown> {
    const outcome = await emit(event);
    if (outcome.answer !== undefined) return outcome.answer;
    if (outcome.errors.length) throw new Error(outcome.errors.join("; "));
    return null;
  }

  return {
    manifest,
    calls,
    toasts,
    notifications,
    invalidations,
    processes,
    asks,
    logs,
    store,
    config,
    stub: (call, value) => {
      stubs.set(call, value);
    },
    answerAsks: (value) => {
      askAnswer = value;
    },
    emit,
    async gate(event) {
      if (!isActionEvent(event.name) && event.name !== "rpc.call")
        throw new Error(`${event.name} is not an action event`);
      return (await emit(event)).gate ?? { decision: "allow" };
    },
    render: (slot, context = {}, entryId) =>
      answer({
        ...context,
        name: "ui.render",
        slot,
        entry_id:
          entryId ??
          manifest.slots.find((entry) => entry.slot === slot)?.id ??
          "default",
        context,
        viewer: { id: "test", mobile: false },
      }),
    command(id, args = null) {
      if (!manifest.commands.some((entry) => entry.id === id))
        return Promise.reject(
          new Error(`${manifest.id} has no command ${JSON.stringify(id)}`),
        );
      return answer({ name: "command.run", command: id, args });
    },
    async close() {
      if (!bridge.closed) await bridge.request("shutdown", {}).catch(() => {});
      bridge.close();
      child.peer.close();
      rmSync(data, { recursive: true, force: true });
    },
  };
}
