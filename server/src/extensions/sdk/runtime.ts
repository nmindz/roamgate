import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type ChildHandleParams,
  type ChildHandleResult,
  type ChildInitParams,
  type ChildInitResult,
  type ChildLogParams,
  EXTENSION_RPC_ERRORS,
  type ExtensionEventBase,
  type ExtensionMatcher,
  type ExtensionMatcherValue,
  type HandlerRegistration,
} from "../../../../shared/extensions";
import { ExtensionRpcError, JsonRpcPeer } from "../protocol";

/**
 * The extension child: `roamgate __ext-host --root <dir> --id <id> --api <v>`.
 * It loads one mod and runs its handlers when the bridge asks; everything the
 * mod does outside its own code goes through `$` back to the bridge.
 */

type Next = (rewritten?: ExtensionEventBase) => Promise<typeof NEXT>;
type Handler = (
  $: unknown,
  event: Readonly<ExtensionEventBase>,
  next: Next,
) => unknown;
type MatcherInput = Record<string, unknown>;
interface HandlerOptions {
  onFailure?: "continue" | "block";
}

const NEXT = Symbol("roamgate.next");
const callContext = new AsyncLocalStorage<{ callId: string }>();

function matcherValue(value: unknown, path: string): ExtensionMatcherValue {
  if (value instanceof RegExp)
    return { $regex: value.source, flags: value.flags };
  if (Array.isArray(value))
    return value.map((item, index) => matcherValue(item, `${path}[${index}]`));
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  throw new TypeError(
    `matcher ${path}: use strings, numbers, booleans, regular expressions or arrays`,
  );
}

export function serializeMatcher(
  matcher: MatcherInput | undefined,
): ExtensionMatcher | undefined {
  if (matcher === undefined) return undefined;
  if (!matcher || typeof matcher !== "object" || Array.isArray(matcher))
    throw new TypeError("matchers are plain objects");
  const serialized: ExtensionMatcher = {};
  for (const [field, value] of Object.entries(matcher))
    serialized[field] = matcherValue(value, field);
  return serialized;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Timers a mod sets through `$.clock`; all cleared when the mod stops. */
function createClock() {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const intervals = new Set<ReturnType<typeof setInterval>>();
  return {
    api: Object.freeze({
      now: () => Date.now(),
      setTimeout(callback: () => void, ms: number) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          callback();
        }, ms);
        timers.add(timer);
        return timer;
      },
      clearTimeout(timer: ReturnType<typeof setTimeout>) {
        timers.delete(timer);
        clearTimeout(timer);
      },
      setInterval(callback: () => void, ms: number) {
        const interval = setInterval(callback, ms);
        intervals.add(interval);
        return interval;
      },
      clearInterval(interval: ReturnType<typeof setInterval>) {
        intervals.delete(interval);
        clearInterval(interval);
      },
    }),
    clear() {
      for (const timer of timers) clearTimeout(timer);
      for (const interval of intervals) clearInterval(interval);
      timers.clear();
      intervals.clear();
    },
  };
}

export interface ExtensionChild {
  peer: JsonRpcPeer;
  /** Resolves with the exit code once the bridge shuts the child down. */
  done: Promise<number>;
}

/**
 * The runtime behind `__ext-host`, transport-independent: `write` sends one
 * line to the bridge; the caller feeds bridge output to `peer.receive`.
 */
export function createExtensionChild(
  write: (line: string) => void,
): ExtensionChild {
  const handlers = new Map<
    string,
    { registration: HandlerRegistration; handler: Handler }
  >();
  const cancellations = new Map<string, (reason: string) => void>();
  const clock = createClock();
  const state = new Map<string, unknown>();
  let nextHandlerId = 1;
  let initialized = false;
  const exit = Promise.withResolvers<number>();

  const peer: JsonRpcPeer = new JsonRpcPeer({
    write,
    onRequest: (method, params) => {
      if (method === "init") return init(params as ChildInitParams);
      if (method === "handle") return handle(params as ChildHandleParams);
      if (method === "shutdown") {
        clock.clear();
        queueMicrotask(() => exit.resolve(0));
        return {};
      }
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.methodNotFound,
        `unknown method: ${method}`,
      );
    },
    onNotification: (method, params) => {
      if (method !== "cancel") return;
      const { call_id: callId, reason } = (params ?? {}) as {
        call_id?: unknown;
        reason?: unknown;
      };
      if (typeof callId === "string")
        cancellations.get(callId)?.(
          typeof reason === "string" ? reason : "cancelled",
        );
    },
    onProtocolError: () => exit.resolve(1),
  });

  function log(
    level: ChildLogParams["level"],
    message: unknown,
    fields?: unknown,
  ) {
    peer.notify("log", {
      level,
      message: typeof message === "string" ? message : String(message),
      fields:
        fields && typeof fields === "object" && !Array.isArray(fields)
          ? (fields as Record<string, unknown>)
          : undefined,
    } satisfies ChildLogParams);
  }

  const logApi = Object.freeze({
    debug: (message: unknown, fields?: unknown) =>
      log("debug", message, fields),
    info: (message: unknown, fields?: unknown) => log("info", message, fields),
    warn: (message: unknown, fields?: unknown) => log("warn", message, fields),
    error: (message: unknown, fields?: unknown) =>
      log("error", message, fields),
  });

  const namespaces = new Map<string, unknown>();
  const local: Record<string, unknown> = {
    state,
    clock: clock.api,
    log: logApi,
  };
  /** `$.ns.method(...args)` becomes one `$` request to the bridge. */
  const $ = new Proxy(Object.create(null), {
    get(_target, ns) {
      if (typeof ns !== "string" || ns === "then") return undefined;
      if (Object.hasOwn(local, ns)) return local[ns];
      let namespace = namespaces.get(ns);
      if (!namespace) {
        namespace = new Proxy(Object.create(null), {
          get(_inner, method) {
            if (typeof method !== "string" || method === "then")
              return undefined;
            return (...args: unknown[]) =>
              peer.request("$", {
                call_id: callContext.getStore()?.callId,
                ns,
                method,
                args,
              });
          },
        });
        namespaces.set(ns, namespace);
      }
      return namespace;
    },
    set: () => false,
  });

  function on(
    event: string,
    matcherOrHandler: MatcherInput | Handler,
    handlerOrOptions?: Handler | HandlerOptions,
    maybeOptions?: HandlerOptions,
  ): void {
    if (typeof event !== "string" || !event)
      throw new TypeError("on(event, ...): event must be a string");
    const [matcher, handler, options] =
      typeof matcherOrHandler === "function"
        ? [
            undefined,
            matcherOrHandler,
            handlerOrOptions as HandlerOptions | undefined,
          ]
        : [matcherOrHandler, handlerOrOptions as Handler, maybeOptions];
    if (typeof handler !== "function")
      throw new TypeError(
        `on(${JSON.stringify(event)}, ...): handler must be a function`,
      );
    const onFailure = options?.onFailure ?? "continue";
    if (onFailure !== "continue" && onFailure !== "block")
      throw new TypeError('onFailure is "continue" or "block"');
    const registration: HandlerRegistration = {
      handler_id: `h${nextHandlerId++}`,
      event,
      matcher: serializeMatcher(matcher),
      on_failure: onFailure,
    };
    handlers.set(registration.handler_id, { registration, handler });
    if (initialized)
      peer
        .request("register", registration)
        .catch((error) =>
          log("error", `registering ${event} failed: ${errorText(error)}`),
        );
  }

  async function init(params: ChildInitParams): Promise<ChildInitResult> {
    if (initialized) throw new Error("already initialized");
    if (typeof params?.mod !== "string")
      throw new Error("init needs the mod path");
    // The mod path is only known at runtime.
    const loaded = (await import(pathToFileURL(params.mod).href)) as {
      register?: unknown;
      default?: { register?: unknown } | ((...args: unknown[]) => unknown);
    };
    const register =
      typeof loaded.register === "function"
        ? loaded.register
        : typeof loaded.default === "function"
          ? loaded.default
          : loaded.default?.register;
    if (typeof register !== "function")
      throw new Error("the mod must export register(on, $)");
    await register(on, $);
    initialized = true;
    const registrations = [...handlers.values()].map(
      (entry) => entry.registration,
    );
    const commands = registrations
      .filter((registration) => registration.event === "command.run")
      .map((registration) => registration.matcher?.command)
      .filter((command): command is string => typeof command === "string");
    return { registrations, commands };
  }

  async function handle(params: ChildHandleParams): Promise<ChildHandleResult> {
    const entry = handlers.get(params.handler_id);
    if (!entry)
      return { kind: "error", message: `unknown handler ${params.handler_id}` };
    let nextCalled = false;
    let rewritten: ExtensionEventBase | undefined;
    const next: Next = (event) => {
      nextCalled = true;
      rewritten = event;
      return Promise.resolve(NEXT);
    };
    const cancelled = Promise.withResolvers<never>();
    cancellations.set(params.call_id, (reason) =>
      cancelled.reject(new Error(`cancelled: ${reason}`)),
    );
    try {
      const event = deepFreeze(params.payload);
      const value = await Promise.race([
        callContext.run({ callId: params.call_id }, () =>
          entry.handler($, event, next),
        ),
        cancelled.promise,
      ]);
      if (value === NEXT || nextCalled || value === undefined) {
        if (rewritten === undefined) return { kind: "next" };
        return { kind: "next", payload: JSON.parse(JSON.stringify(rewritten)) };
      }
      return { kind: "answer", value: JSON.parse(JSON.stringify(value)) };
    } catch (error) {
      return { kind: "error", message: errorText(error) };
    } finally {
      cancellations.delete(params.call_id);
    }
  }

  return { peer, done: exit.promise };
}

/** Entry of the hidden `__ext-host` command. Never returns before shutdown. */
export async function runExtensionHost(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: "string" },
      id: { type: "string" },
      api: { type: "string" },
    },
    strict: true,
  });
  if (!values.root || !values.id) {
    process.stderr.write("__ext-host needs --root and --id\n");
    return 2;
  }
  process.chdir(values.root);
  // Keep a private stdout writer, then divert the mod's stdout to stderr.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const child = createExtensionChild((line) => {
    stdoutWrite(line);
  });
  process.stdout.write = ((chunk: string | Uint8Array) =>
    process.stderr.write(chunk)) as typeof process.stdout.write;
  const levels = {
    log: "info",
    info: "info",
    debug: "debug",
    warn: "warn",
    error: "error",
  } as const;
  for (const [name, level] of Object.entries(levels)) {
    (console as unknown as Record<string, unknown>)[name] = (
      ...items: unknown[]
    ) =>
      child.peer.notify("log", {
        level,
        message: items
          .map((item) => (typeof item === "string" ? item : Bun.inspect(item)))
          .join(" "),
      });
  }
  process.on("uncaughtException", (error) =>
    child.peer.notify("log", {
      level: "error",
      message: `uncaught: ${errorText(error)}`,
    }),
  );
  process.on("unhandledRejection", (error) =>
    child.peer.notify("log", {
      level: "error",
      message: `unhandled rejection: ${errorText(error)}`,
    }),
  );
  process.stdin.on("data", (chunk: Buffer) => child.peer.receive(chunk));
  // The bridge went away: nothing may outlive it.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  const code = await child.done;
  // Let the shutdown reply leave before the caller exits.
  await new Promise<void>((resolve) => stdoutWrite("", () => resolve()));
  return code;
}
