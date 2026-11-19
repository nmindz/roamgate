import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import {
  EXTENSION_RPC_ERRORS,
  type ExtensionCapability,
  type ExtensionManifest,
  type ToastSlotData,
} from "../../../shared/extensions";
import { sshCommandArgv, sshReadCommandArgv } from "../bridge/ssh-command";
import { runInSshLane } from "../bridge/ssh-sessions";
import { terminalUploadMaxBytes } from "../http/terminal-upload";
import {
  type ProcessRunResult,
  runProcessWithCodeTimeout,
  shQuote,
} from "../utils/process-utils";
import { PREVIEW_IMAGE_MAX_BYTES } from "../workspace/file-constants";
import { sanitizeMutationPath } from "../workspace/file-paths";
import { gateAction, gateRpcAction, runWithOrigin } from "./action-events";
import { resolveAsk } from "./approvals";
import type { ExtensionBus } from "./events";
import {
  assertDollarCallAllowed,
  extensionEnvironment,
  GuardError,
  parseGate,
} from "./guard";
import { hostMatches } from "./manifest";
import { ExtensionRpcError } from "./protocol";
import type { ExtensionStore } from "./store";

export const PROCESS_DEFAULT_TIMEOUT_MS = 30_000;
export const PROCESS_MAX_TIMEOUT_MS = 10 * 60_000;
export const PROCESS_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
export const FETCH_DEFAULT_TIMEOUT_MS = 30_000;
export const FETCH_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 5;
export const FRAME_EVENT_LIMIT_BYTES = 256 * 1024;
const HERDR_CALL_TIMEOUT_MS = 30_000;
/** The largest file `file.read` returns whole (an image preview). */
export const FILES_READ_LIMIT_BYTES = PREVIEW_IMAGE_MAX_BYTES;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** One connection runtime pinned to the generation the caller saw. */
export interface DollarConnectionLease {
  connectionId: string;
  generation: number;
  isCurrent(): boolean;
  /** Herdr call on this connection. */
  call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  /** SSH destination when the connection runs over SSH. */
  sshHost?: string;
  remotePlatform?: string;
  readAgentSession?(params: Record<string, unknown>): Promise<unknown>;
  readAgentHistory?(params: Record<string, unknown>): Promise<unknown>;
  /** Checkout files on this connection, through the bridge's file handlers. */
  files?: {
    read(
      params: { workspace_id: string; path: string },
      limit: number,
    ): Promise<{ path: string; size: number; bytes: Buffer }>;
    write(
      params: { workspace_id: string; directory: string; filename: string },
      body: Buffer,
    ): Promise<{ path: string; size: number }>;
  };
}

/** What the `$` API reaches in the bridge; index.ts supplies the real ones. */
export interface DollarHost {
  /** A ready lease, or null when the connection is unknown or not ready. */
  lease(connectionId: string | undefined): DollarConnectionLease | null;
  connections(): unknown[];
  notify(
    ext: string,
    message: { title: string; body: string; target?: unknown },
  ): void;
  toast(ext: string, toast: ToastSlotData): void;
  invalidate(ext: string, slot?: string): void;
  /** Delivers `$.events.emit` to the extension's frames in every browser. */
  frameEvent?(
    ext: string,
    event: { frame?: string; name: string; data: unknown },
  ): void;
  /** The extension's settings (secret values only with `secrets`); connection-scoped ones for `connectionId`. */
  config?(ext: string, connectionId?: string): Promise<Record<string, unknown>>;
  bus: ExtensionBus;
  fetch?: typeof fetch;
}

export interface DollarContext {
  ext: string;
  manifest: ExtensionManifest;
  store: ExtensionStore;
  /** The extension directory, default cwd for local processes. */
  root: string;
  host: DollarHost;
}

/** The event a `$` call was made from: connection calls default to its generation. */
export interface DollarCallScope {
  connection?: { id: string; generation: number };
  /** The event's workspace: `$.files` paths are relative to its checkout. */
  workspace_id?: string;
}

const callScope = new AsyncLocalStorage<DollarCallScope>();

function capabilityError(
  ext: string,
  capability: ExtensionCapability,
  call: string,
) {
  return new ExtensionRpcError(
    EXTENSION_RPC_ERRORS.capability,
    `${call} needs the "${capability}" capability, which ${ext} does not declare`,
  );
}

function invalid(message: string) {
  return new ExtensionRpcError(EXTENSION_RPC_ERRORS.invalidParams, message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw invalid(`${name} must be a non-empty string`);
  return value;
}

function timeout(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw invalid("timeout must be a positive number of milliseconds");
  return Math.min(value, max);
}

/** Herdr methods that only read; anything else needs herdr.write. */
const HERDR_READ_METHOD =
  /^(?:ping|[a-z_]+\.(?:list|get|read|status|info|schema|wait_for_output))$/;

/** Methods an extension reaches through `$.herdr.call` but never through gated paths. */
const HERDR_BLOCKED = /^(?:events?\.|subscribe|plugin\.(?:install|uninstall))/;

async function readBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    if (size + chunk.byteLength > limit) {
      await response.body.cancel().catch(() => undefined);
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.invalidParams,
        `response body exceeds ${limit} bytes`,
      );
    }
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The bridge side of `$`: every call an extension's mod makes outside its own
 * code, checked against its declared capabilities and the guard.
 */
export function createDollarDispatcher(
  context: DollarContext,
): DollarDispatcher {
  const { ext, manifest, host } = context;
  const capabilities = new Set(manifest.capabilities);
  const need = (capability: ExtensionCapability, call: string) => {
    if (!capabilities.has(capability))
      throw capabilityError(ext, capability, call);
  };
  const origin = `extension:${ext}` as const;

  /** The connection a call acts on: explicit, else the handler's event; pinned to its generation. */
  const lease = (requested: unknown): DollarConnectionLease => {
    const explicit = typeof requested === "string" ? requested : undefined;
    const fromEvent = callScope.getStore()?.connection;
    const id = explicit ?? fromEvent?.id;
    const current = host.lease(id);
    if (!current)
      throw new Error(`connection is not ready: ${id ?? "default"}`);
    if (
      fromEvent &&
      (explicit === undefined || explicit === fromEvent.id) &&
      current.generation !== fromEvent.generation
    )
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.connectionChanged,
        "connection changed",
      );
    return current;
  };
  const checkCurrent = (current: DollarConnectionLease) => {
    if (!current.isCurrent())
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.connectionChanged,
        "connection changed",
      );
  };

  /** Mutations raise the same action events as the UI, with this extension as origin. */
  const herdrMutation = async (
    current: DollarConnectionLease,
    method: string,
    params: Record<string, unknown>,
  ) => {
    const effective = await gateRpcAction(
      { id: current.connectionId, generation: current.generation },
      method,
      params,
      { origin, bus: host.bus },
    );
    checkCurrent(current);
    const result = await current.call(method, effective, HERDR_CALL_TIMEOUT_MS);
    // A reply from a replaced runtime is not reported as success.
    checkCurrent(current);
    return result;
  };

  const herdrCall = async (
    connection: unknown,
    method: unknown,
    params: unknown,
  ) => {
    const name = text(method, "method");
    const args = record(params, "params");
    if (HERDR_BLOCKED.test(name))
      throw new GuardError(`${name} is not available to extensions`);
    const read = HERDR_READ_METHOD.test(name);
    need(read ? "herdr.read" : "herdr.write", `$.herdr.call(${name})`);
    const current = lease(connection);
    if (read) {
      const result = await current.call(name, args, HERDR_CALL_TIMEOUT_MS);
      checkCurrent(current);
      return result;
    }
    return herdrMutation(current, name, args);
  };

  const processRun = async (argvValue: unknown, optionsValue: unknown) => {
    if (
      !Array.isArray(argvValue) ||
      argvValue.length === 0 ||
      !argvValue.every((item) => typeof item === "string") ||
      !argvValue[0]
    )
      throw invalid("$.process.run takes an argv array of strings");
    const argv = argvValue as string[];
    const options = record(optionsValue, "options");
    const timeoutMs = timeout(
      options.timeout,
      PROCESS_DEFAULT_TIMEOUT_MS,
      PROCESS_MAX_TIMEOUT_MS,
    );
    const env = record(options.env, "options.env") as Record<string, string>;
    const input = options.stdin;
    if (input !== undefined && typeof input !== "string")
      throw invalid("options.stdin must be a string");
    const cwd = options.cwd;
    if (cwd !== undefined && (typeof cwd !== "string" || !cwd))
      throw invalid("options.cwd must be a path");
    let result: ProcessRunResult;
    if (options.connection === undefined) {
      need("process", "$.process.run");
      if (cwd !== undefined && !isAbsolute(cwd))
        throw invalid("options.cwd must be absolute");
      result = await runProcessWithCodeTimeout(argv, timeoutMs, {
        cwd: (cwd as string | undefined) ?? context.root,
        env: extensionEnvironment(process.env, env),
        input,
        maxOutputBytes: PROCESS_OUTPUT_LIMIT_BYTES,
      });
    } else {
      need("process.remote", "$.process.run({ connection })");
      const current = lease(options.connection);
      if (!current.sshHost) {
        throw invalid(
          "options.connection names a local connection; run without it",
        );
      }
      if (current.remotePlatform === "windows")
        throw new ExtensionRpcError(
          EXTENSION_RPC_ERRORS.invalidParams,
          "unsupported on this connection: the host runs Windows",
        );
      extensionEnvironment({}, env);
      const assignments = Object.entries(env).map(([name, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          throw invalid(`invalid environment name: ${name}`);
        return `${name}=${shQuote(value)}`;
      });
      const command = [
        ...(cwd === undefined ? [] : [`cd ${shQuote(cwd as string)} &&`]),
        ...(assignments.length ? ["env", ...assignments] : []),
        ...argv.map(shQuote),
      ].join(" ");
      const remoteArgv =
        options.readOnly === true
          ? sshReadCommandArgv(current.sshHost, command, [], `extension:${ext}`)
          : sshCommandArgv(current.sshHost, command, [], `extension:${ext}`);
      result = await runInSshLane("background", () =>
        runProcessWithCodeTimeout(remoteArgv, timeoutMs, {
          input,
          maxOutputBytes: PROCESS_OUTPUT_LIMIT_BYTES,
        }),
      );
      checkCurrent(current);
    }
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.truncated ? { truncated: true } : {}),
    };
  };

  const httpFetch = async (urlValue: unknown, initValue: unknown) => {
    need("network", "$.http.fetch");
    let url: URL;
    try {
      url = new URL(text(urlValue, "url"));
    } catch (error) {
      if (error instanceof ExtensionRpcError) throw error;
      throw invalid("url must be an absolute URL");
    }
    const init = record(initValue, "init");
    const method =
      typeof init.method === "string" ? init.method.toUpperCase() : "GET";
    const headers = record(init.headers, "init.headers");
    for (const [name, value] of Object.entries(headers))
      if (typeof value !== "string")
        throw invalid(`header ${name} must be a string`);
    const body = init.body;
    if (body !== undefined && typeof body !== "string")
      throw invalid("init.body must be a string");
    const timeoutMs = timeout(
      init.timeout,
      FETCH_DEFAULT_TIMEOUT_MS,
      PROCESS_MAX_TIMEOUT_MS,
    );
    const signal = AbortSignal.timeout(timeoutMs);
    const doFetch = host.fetch ?? fetch;
    for (let redirects = 0; ; redirects++) {
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw invalid(`unsupported URL scheme: ${url.protocol}`);
      if (!hostMatches(manifest.network_hosts, url))
        throw new GuardError(`${url.host} is not in network_hosts`);
      const response = await doFetch(url, {
        method,
        headers: headers as Record<string, string>,
        body:
          redirects === 0 || method === "GET"
            ? (body as string | undefined)
            : undefined,
        redirect: "manual",
        signal,
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects >= FETCH_MAX_REDIRECTS)
          throw new Error(`more than ${FETCH_MAX_REDIRECTS} redirects`);
        url = new URL(location, url);
        continue;
      }
      const responseBody = await readBody(response, FETCH_BODY_LIMIT_BYTES);
      return {
        status: response.status,
        ok: response.ok,
        url: url.href,
        headers: Object.fromEntries(response.headers),
        body: responseBody,
      };
    }
  };

  const paneTarget = (args: unknown[]) => {
    const pane = args[0];
    if (typeof pane === "string")
      return { paneId: pane, connection: undefined };
    const target = record(pane, "pane");
    return {
      paneId: text(target.pane_id, "pane.pane_id"),
      connection: target.connection,
    };
  };

  /** The checkout a `$.files` call acts on: an explicit workspace, else the event's. */
  const checkout = (optionsValue: unknown, call: string) => {
    const options = record(optionsValue, "options");
    const { workspace_id: explicit, connection } = options;
    if (explicit !== undefined && (typeof explicit !== "string" || !explicit))
      throw invalid("options.workspace_id must be a non-empty string");
    if (connection !== undefined && typeof connection !== "string")
      throw invalid("options.connection must be a string");
    const scope = callScope.getStore();
    // The event's workspace only names a checkout on the event's connection.
    const workspaceId =
      (explicit as string | undefined) ??
      (connection === undefined || connection === scope?.connection?.id
        ? scope?.workspace_id
        : undefined);
    if (!workspaceId)
      throw invalid(
        `${call} needs a workspace: call it from a workspace event or pass { workspace_id }`,
      );
    const current = lease(connection);
    if (current.remotePlatform === "windows")
      throw invalid("unsupported on this connection: the host runs Windows");
    if (!current.files)
      throw new Error("checkout files are not available on this connection");
    return { options, workspaceId, current, files: current.files };
  };
  const checkoutPath = (value: unknown) => {
    let path = "";
    try {
      path = sanitizeMutationPath(value);
    } catch {}
    if (!path)
      throw invalid(
        'path must be relative to the workspace checkout, without ".."',
      );
    return path;
  };
  const encodingOf = (value: unknown) => {
    if (value === undefined || value === "utf8" || value === "base64")
      return value;
    throw invalid('options.encoding must be "utf8" or "base64"');
  };

  const handlers: Record<string, (args: unknown[]) => unknown> = {
    "config.all": async () =>
      (await host.config?.(ext, callScope.getStore()?.connection?.id)) ?? {},
    "config.get": async ([key]) => {
      const name = text(key, "key");
      if (manifest.config[name]?.type === "secret")
        need("secrets", `$.config.get(${JSON.stringify(name)})`);
      return (
        ((await host.config?.(ext, callScope.getStore()?.connection?.id)) ??
          {})[name] ?? null
      );
    },
    "store.get": ([key]) => context.store.get(key),
    "store.set": ([key, value]) => {
      context.store.set(key, value);
      return null;
    },
    "store.delete": ([key]) => context.store.delete(key),
    "store.keys": () => context.store.keys(),
    "roamgate.connections": () => {
      need("workspace.read", "$.roamgate.connections");
      return host.connections();
    },
    "roamgate.workspaces": async ([connection]) => {
      need("workspace.read", "$.roamgate.workspaces");
      const current = lease(connection);
      const result = await current.call(
        "workspace.list",
        {},
        HERDR_CALL_TIMEOUT_MS,
      );
      checkCurrent(current);
      return result;
    },
    "roamgate.tabs": async ([params, connection]) => {
      need("workspace.read", "$.roamgate.tabs");
      const current = lease(connection);
      const result = await current.call(
        "tab.list",
        record(params, "params"),
        HERDR_CALL_TIMEOUT_MS,
      );
      checkCurrent(current);
      return result;
    },
    "roamgate.panes": async ([params, connection]) => {
      need("workspace.read", "$.roamgate.panes");
      const current = lease(connection);
      const result = await current.call(
        "pane.list",
        record(params, "params"),
        HERDR_CALL_TIMEOUT_MS,
      );
      checkCurrent(current);
      return result;
    },
    "roamgate.agents": async ([connection]) => {
      need("workspace.read", "$.roamgate.agents");
      const current = lease(connection);
      const result = await current.call(
        "agent.list",
        {},
        HERDR_CALL_TIMEOUT_MS,
      );
      checkCurrent(current);
      return result;
    },
    "herdr.call": ([connection, method, params]) =>
      herdrCall(connection, method, params),
    "terminal.send": async (args) => {
      need("terminal.write", "$.terminal.send");
      const { paneId, connection } = paneTarget(args);
      if (typeof args[1] !== "string") throw invalid("text must be a string");
      return herdrMutation(lease(connection), "pane.send_text", {
        pane_id: paneId,
        text: args[1],
      });
    },
    "terminal.keys": async (args) => {
      need("terminal.write", "$.terminal.keys");
      const { paneId, connection } = paneTarget(args);
      const keys = Array.isArray(args[1]) ? args[1] : [args[1]];
      if (!keys.every((key) => typeof key === "string" && key))
        throw invalid("keys must be strings");
      return herdrMutation(lease(connection), "pane.send_keys", {
        pane_id: paneId,
        keys,
      });
    },
    "terminal.screen": async (args) => {
      need("terminal.read", "$.terminal.screen");
      const { paneId, connection } = paneTarget(args);
      const options = record(args[1], "options");
      const current = lease(connection);
      const result = await current.call(
        "pane.read",
        {
          pane_id: paneId,
          source: options.source ?? "recent",
          lines: options.lines ?? 200,
        },
        HERDR_CALL_TIMEOUT_MS,
      );
      checkCurrent(current);
      return result;
    },
    "agent.session": async (args) => {
      need("agent.sessions", "$.agent.session");
      const { paneId, connection } = paneTarget(args);
      const current = lease(connection);
      if (!current.readAgentSession)
        throw new Error("agent sessions are not available on this connection");
      const result = await current.readAgentSession({ pane_id: paneId });
      checkCurrent(current);
      return result;
    },
    "agent.history": async (args) => {
      need("agent.sessions", "$.agent.history");
      const { paneId, connection } = paneTarget(args);
      const current = lease(connection);
      if (!current.readAgentHistory)
        throw new Error("agent history is not available on this connection");
      const result = await current.readAgentHistory({
        pane_id: paneId,
        ...record(args[1], "options"),
      });
      checkCurrent(current);
      return result;
    },
    "notify.push": async ([message]) => {
      need("notifications", "$.notify.push");
      const value = record(message, "message");
      const payload = {
        title: text(value.title, "title").slice(0, 200),
        body: typeof value.body === "string" ? value.body.slice(0, 2_000) : "",
        target: value.target,
      };
      const outcome = await host.bus.run({
        name: "notify.send",
        origin,
        ...payload,
      });
      if (
        (outcome.answer?.value as { suppress?: unknown } | undefined)
          ?.suppress === true
      )
        return { suppressed: true };
      host.notify(ext, {
        title: String(outcome.event.title ?? payload.title),
        body: String(outcome.event.body ?? payload.body),
        target: payload.target,
      });
      return { suppressed: false };
    },
    "ui.toast": ([value]) => {
      need("ui", "$.ui.toast");
      const toast = record(value, "toast");
      const kind = (["info", "success", "warning", "error"] as const).find(
        (value) => value === toast.kind,
      );
      host.toast(ext, {
        kind: kind ?? "info",
        message: text(toast.message, "message").slice(0, 500),
        detail:
          typeof toast.detail === "string"
            ? toast.detail.slice(0, 2_000)
            : undefined,
        command: typeof toast.command === "string" ? toast.command : undefined,
      });
      return null;
    },
    "ui.invalidate": ([slot]) => {
      need("ui", "$.ui.invalidate");
      if (slot !== undefined && typeof slot !== "string")
        throw invalid("slot must be a string");
      host.invalidate(ext, slot as string | undefined);
      return null;
    },
    "events.emit": ([name, data, options]) => {
      need("ui", "$.events.emit");
      const eventName = text(name, "name");
      if (eventName.length > 200) throw invalid("name is over 200 characters");
      const frame = record(options, "options").frame;
      if (
        frame !== undefined &&
        (typeof frame !== "string" ||
          !manifest.frames.some((entry) => entry.id === frame))
      )
        throw invalid(`${ext} declares no frame ${JSON.stringify(frame)}`);
      const encoded = JSON.stringify(data ?? null);
      if (Buffer.byteLength(encoded) > FRAME_EVENT_LIMIT_BYTES)
        throw invalid(`data is over ${FRAME_EVENT_LIMIT_BYTES} bytes`);
      host.frameEvent?.(ext, {
        ...(frame === undefined ? {} : { frame: frame as string }),
        name: eventName,
        data: JSON.parse(encoded),
      });
      return null;
    },
    "ui.ask": async ([value]) => {
      need("gates", "$.ui.ask");
      const gate = parseGate({ ...record(value, "ask"), decision: "ask" }, ext);
      if (gate.decision !== "ask") throw invalid("ask needs a title");
      const connection = callScope.getStore()?.connection;
      const decided = await resolveAsk(gate, {
        name: "ui.ask",
        origin,
        ...(connection ? { connection } : {}),
      });
      return {
        approved: decided.decision === "allow",
        ...(decided.decision === "deny" ? { reason: decided.reason } : {}),
      };
    },
    "process.run": ([argv, options]) => processRun(argv, options),
    "http.fetch": ([url, init]) => httpFetch(url, init),
    "files.read": async ([path, options]) => {
      need("files.read", "$.files.read");
      const relative = checkoutPath(path);
      const target = checkout(options, "$.files.read");
      const encoding = encodingOf(target.options.encoding);
      const { bytes } = await target.files.read(
        { workspace_id: target.workspaceId, path: relative },
        FILES_READ_LIMIT_BYTES,
      );
      checkCurrent(target.current);
      // Without an encoding, text with NUL bytes is treated as binary.
      if (encoding === "utf8" || (!encoding && !bytes.includes(0))) {
        try {
          return {
            content: UTF8.decode(bytes),
            encoding: "utf8",
            size: bytes.length,
          };
        } catch {
          if (encoding)
            throw invalid(
              `${relative} is not UTF-8; read it with { encoding: "base64" }`,
            );
        }
      }
      return {
        content: bytes.toString("base64"),
        encoding: "base64",
        size: bytes.length,
      };
    },
    "files.write": async ([path, content, options]) => {
      need("files.write", "$.files.write");
      const relative = checkoutPath(path);
      if (typeof content !== "string")
        throw invalid("content must be a string");
      const target = checkout(options, "$.files.write");
      const encoding = encodingOf(target.options.encoding) ?? "utf8";
      if (encoding === "base64" && !BASE64.test(content))
        throw invalid("content is not base64");
      const body = Buffer.from(content, encoding);
      const limit = terminalUploadMaxBytes();
      if (body.length > limit) throw invalid(`content is over ${limit} bytes`);
      const { current, workspaceId } = target;
      await gateAction(
        {
          name: "file.write",
          origin,
          connection: {
            id: current.connectionId,
            generation: current.generation,
          },
          workspace_id: workspaceId,
          op: "upload",
          paths: [relative],
        },
        host.bus,
      );
      checkCurrent(current);
      const slash = relative.lastIndexOf("/");
      const written = await target.files.write(
        {
          workspace_id: workspaceId,
          directory: relative.slice(0, Math.max(slash, 0)),
          filename: relative.slice(slash + 1),
        },
        body,
      );
      checkCurrent(current);
      return { ok: true, size: written.size };
    },
  };

  return {
    async call(ns, method, args, scope) {
      if (typeof ns !== "string" || typeof method !== "string")
        throw invalid("$ calls need a namespace and method");
      assertDollarCallAllowed(ns, method);
      if (!Array.isArray(args)) throw invalid("$ arguments must be an array");
      const handler = handlers[`${ns}.${method}`];
      if (!handler)
        throw new ExtensionRpcError(
          EXTENSION_RPC_ERRORS.methodNotFound,
          `$.${ns}.${method} is not available`,
        );
      return callScope.run(scope ?? {}, () =>
        runWithOrigin(origin, () => handler(args)),
      );
    },
  };
}

export interface DollarDispatcher {
  call(
    ns: string,
    method: string,
    args: unknown[],
    scope?: DollarCallScope,
  ): Promise<unknown>;
}
