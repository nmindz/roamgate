import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Subprocess } from "bun";
import {
  type ExtensionEventBase,
  type ExtensionHookContribution,
  type ExtensionPlatform,
  matchesEvent,
} from "../../../shared/extensions";
import { isRecord } from "../agent/session-utils";
import { ensureDataDirectory } from "../config/data-paths";
import type { DispatchMode, DispatchOutcome } from "./events";
import {
  combineGates,
  type DecidedGate,
  extensionEnvironment,
  parseGate,
} from "./guard";
import { hookUrlError, hostPlatform } from "./manifest";
import type { ExtensionPaths } from "./paths";

/** argv[0] that runs a script with Roamgate's embedded Bun runtime. */
export const ROAMGATE_BUN = "roamgate:bun";
export const HOOK_DEFAULT_TIMEOUT_S = 30;
export const HOOK_MAX_TIMEOUT_S = 600;
/** Per stream, or per url hook answer; more output is a hook failure. */
export const HOOK_OUTPUT_MAX_BYTES = 1024 * 1024;
const MESSAGE_LIMIT = 2_000;
const STDERR_IN_ERROR_LIMIT = 500;

export type CommandHook = ExtensionHookContribution & { command: string[] };
export type UrlHook = ExtensionHookContribution & { url: string };
/** A `[[hooks]]` entry: a command, or a url it POSTs the event to. */
export type RunnableHook = CommandHook | UrlHook;

export interface CommandHookTarget {
  ext: string;
  root: string;
  paths: ExtensionPaths;
  hook: RunnableHook;
  /** The manifest's `network_hosts`; url hooks may reach these and loopback. */
  networkHosts?: readonly string[];
}

export type CommandHookResult =
  | {
      ok: true;
      gate?: DecidedGate;
      rewrite?: Record<string, unknown>;
      message?: string;
    }
  | { ok: false; error: string };

export interface CommandHookOptions {
  /** The runtime `roamgate:bun` starts; defaults to this process. */
  execPath?: string;
  /** Inherited environment, filtered through the extension allowlist. */
  env?: Record<string, string | undefined>;
}

/** Where the host records what hooks did; failures follow the host's policy. */
export interface CommandHookSink {
  fail(
    ext: string,
    message: string,
    policy: "continue" | "block",
  ): Pick<DispatchOutcome, "gate" | "answer"> | null;
  log(ext: string, message: string): void;
}

export interface CommandHooksOutcome {
  gate?: DecidedGate;
  answer?: DispatchOutcome["answer"];
  /** Validated by the host as handler rewrites are, in hook order. */
  rewrites: Array<{ ext: string; rewrite: Record<string, unknown> }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRunnableHook(
  hook: ExtensionHookContribution,
  platform: ExtensionPlatform | null,
): hook is RunnableHook {
  return (
    ((Array.isArray(hook.command) && hook.command.length > 0) ||
      typeof hook.url === "string") &&
    (!hook.platforms || (!!platform && hook.platforms.includes(platform)))
  );
}

/** Events an extension's command and url hooks run for on this platform. */
export function commandHookEvents(
  hooks: readonly ExtensionHookContribution[],
  platform = hostPlatform(),
): string[] {
  return [
    ...new Set(
      hooks.filter((hook) => isRunnableHook(hook, platform)).map((h) => h.on),
    ),
  ];
}

/** The command and url hooks that run for `event`, by `on`, `matcher` and platform. */
export function matchingCommandHooks(
  hooks: readonly ExtensionHookContribution[],
  event: ExtensionEventBase,
  platform = hostPlatform(),
): RunnableHook[] {
  return hooks.filter(
    (hook): hook is RunnableHook =>
      hook.on === event.name &&
      isRunnableHook(hook, platform) &&
      matchesEvent(hook.matcher, event),
  );
}

export function hookTimeoutMs(hook: ExtensionHookContribution): number {
  const seconds =
    typeof hook.timeout === "number" && hook.timeout > 0
      ? Math.min(hook.timeout, HOOK_MAX_TIMEOUT_S)
      : HOOK_DEFAULT_TIMEOUT_S;
  return seconds * 1000;
}

function isRelativePath(item: string): boolean {
  return /^\.\.?[\\/]/.test(item);
}

/**
 * The argv a hook runs: relative paths become real paths that must stay in
 * the extension directory, and `roamgate:bun` becomes this binary acting as
 * Bun. No shell is involved.
 */
export async function resolveHookArgv(
  root: string,
  command: readonly string[],
  execPath = process.execPath,
): Promise<{ argv: string[]; env: Record<string, string> }> {
  const realRoot = await realpath(root);
  const inside = async (item: string): Promise<string> => {
    const real = await realpath(resolve(realRoot, item)).catch(() => {
      throw new Error(`${item} does not exist in the extension directory`);
    });
    const path = relative(realRoot, real);
    if (
      !path ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path)
    )
      throw new Error(`${item} resolves outside the extension directory`);
    return real;
  };
  const resolveArgs = (items: readonly string[]) =>
    Promise.all(
      items.map((item) => (isRelativePath(item) ? inside(item) : item)),
    );
  if (command[0] !== ROAMGATE_BUN)
    return { argv: await resolveArgs(command), env: {} };
  const script = command[1];
  if (!script || isAbsolute(script))
    throw new Error(
      `${ROAMGATE_BUN} needs a script path relative to the extension directory`,
    );
  return {
    argv: [
      execPath,
      "run",
      await inside(script),
      ...(await resolveArgs(command.slice(2))),
    ],
    // Without it a standalone binary starts Roamgate instead of the script.
    env: { BUN_BE_BUN: "1" },
  };
}

/** The documented variables on top of the credential-free allowlist. */
export function hookEnvironment(
  target: Pick<CommandHookTarget, "ext" | "root"> & { data: string },
  event: ExtensionEventBase,
  base: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const vars: Record<string, string> = {
    ROAMGATE_EXTENSION_ID: target.ext,
    ROAMGATE_EXTENSION_ROOT: target.root,
    ROAMGATE_EXTENSION_DATA: target.data,
    ROAMGATE_EVENT: event.name,
  };
  if (typeof event.connection?.id === "string")
    vars.ROAMGATE_CONNECTION_ID = event.connection.id;
  if (typeof event.workspace_id === "string")
    vars.ROAMGATE_WORKSPACE_ID = event.workspace_id;
  if (typeof event.pane_id === "string") vars.ROAMGATE_PANE_ID = event.pane_id;
  if (typeof event.checkout_path === "string")
    vars.ROAMGATE_CHECKOUT_PATH = event.checkout_path;
  return extensionEnvironment(base, { ...extra, ...vars });
}

/** Kills the hook and anything it started. */
function killTree(proc: Subprocess): void {
  if (process.platform === "win32") {
    try {
      Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      return;
    } catch {}
  } else {
    try {
      // Hooks start in their own process group (detached), led by the hook.
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {}
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) {
      onOverflow();
      break;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type SpawnResult =
  | { code: number; stdout: string; stderr: string }
  | { error: string };

async function spawnHook(
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    input: string;
    timeoutMs: number;
  },
): Promise<SpawnResult> {
  let proc: Subprocess<Uint8Array, "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: Buffer.from(options.input),
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    return { error: `could not start: ${errorText(error)}` };
  }
  const aborted = Promise.withResolvers<{ error: string }>();
  let failed = false;
  const abort = (error: string) => {
    if (failed) return;
    failed = true;
    killTree(proc);
    aborted.resolve({ error });
  };
  const timer = setTimeout(
    () => abort(`timed out after ${options.timeoutMs}ms`),
    options.timeoutMs,
  );
  const overflow = () =>
    abort(`output exceeded ${HOOK_OUTPUT_MAX_BYTES} bytes`);
  const finished = Promise.all([
    readCapped(proc.stdout, HOOK_OUTPUT_MAX_BYTES, overflow),
    readCapped(proc.stderr, HOOK_OUTPUT_MAX_BYTES, overflow),
    proc.exited,
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }));
  try {
    const result = await Promise.race([finished, aborted.promise]);
    return failed ? await aborted.promise : result;
  } finally {
    clearTimeout(timer);
  }
}

function hookGate(
  record: Record<string, unknown>,
  ext: string,
  event: ExtensionEventBase,
): DecidedGate {
  if (record.decision !== "ask") return parseGate(record, ext);
  // An ask needs a title; hooks usually give only a reason.
  const title =
    typeof record.title === "string" && record.title
      ? record.title
      : typeof record.reason === "string" && record.reason
        ? record.reason
        : `${ext} asks before ${event.name}`;
  return parseGate({ ...record, title }, ext);
}

type HookOutput = Omit<Extract<CommandHookResult, { ok: true }>, "ok">;

/** `{decision?, reason?, title?, rewrite?, message?}` from a hook's answer. */
function hookRecordOutput(
  record: Record<string, unknown>,
  ext: string,
  event: ExtensionEventBase,
): HookOutput {
  const output: HookOutput = {};
  if (record.decision !== undefined) output.gate = hookGate(record, ext, event);
  if (record.rewrite !== undefined) {
    if (
      !record.rewrite ||
      typeof record.rewrite !== "object" ||
      Array.isArray(record.rewrite)
    )
      throw new Error("rewrite must be an object");
    output.rewrite = record.rewrite as Record<string, unknown>;
  }
  if (typeof record.message === "string" && record.message)
    output.message = record.message.slice(0, MESSAGE_LIMIT);
  return output;
}

/** Exit-0 stdout: JSON may carry a decision, rewrite or message; text is ignored. */
function parseHookOutput(
  stdout: string,
  ext: string,
  event: ExtensionEventBase,
): HookOutput {
  const text = stdout.trim();
  if (!text.startsWith("{")) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  return isRecord(value) ? hookRecordOutput(value, ext, event) : {};
}

/** Runs one command hook with the event JSON on stdin. Never throws. */
export async function runCommandHook(
  target: CommandHookTarget & { hook: CommandHook },
  event: ExtensionEventBase,
  options: CommandHookOptions = {},
): Promise<CommandHookResult> {
  const label = `command hook ${JSON.stringify(target.hook.command)}`;
  let argv: string[];
  let env: Record<string, string>;
  try {
    const resolved = await resolveHookArgv(
      target.root,
      target.hook.command,
      options.execPath,
    );
    const data = target.paths.dataDir(target.ext);
    ensureDataDirectory(target.paths.root, data);
    argv = resolved.argv;
    env = hookEnvironment(
      { ext: target.ext, root: target.root, data },
      event,
      options.env ?? process.env,
      resolved.env,
    );
  } catch (error) {
    return { ok: false, error: `${label}: ${errorText(error)}` };
  }
  const run = await spawnHook(argv, {
    cwd: target.root,
    env,
    input: JSON.stringify(event),
    timeoutMs: hookTimeoutMs(target.hook),
  });
  if ("error" in run) return { ok: false, error: `${label} ${run.error}` };
  const stderr = run.stderr.trim();
  if (run.code === 2)
    return {
      ok: true,
      gate: parseGate(
        { decision: "deny", reason: stderr || `${label} denied` },
        target.ext,
      ),
    };
  if (run.code !== 0)
    return {
      ok: false,
      error: `${label} exited with code ${run.code}${
        stderr ? `: ${stderr.slice(0, STDERR_IN_ERROR_LIMIT)}` : ""
      }`,
    };
  try {
    return { ok: true, ...parseHookOutput(run.stdout, target.ext, event) };
  } catch (error) {
    return { ok: false, error: `${label}: ${errorText(error)}` };
  }
}

/**
 * POSTs the event JSON to a url hook, without redirects or credentials. A 2xx
 * answer is read like command stdout, but must be empty or a JSON object.
 * Never throws.
 */
export async function runUrlHook(
  target: CommandHookTarget & { hook: UrlHook },
  event: ExtensionEventBase,
): Promise<CommandHookResult> {
  const { url } = target.hook;
  const label = `url hook ${url}`;
  const refused = hookUrlError(url, target.networkHosts ?? []);
  if (refused) return { ok: false, error: `${label}: ${refused}` };
  const timeoutMs = hookTimeoutMs(target.hook);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, error: `${label} answered HTTP ${response.status}` };
    }
    let overflowed = false;
    const body = response.body
      ? await readCapped(response.body, HOOK_OUTPUT_MAX_BYTES, () => {
          overflowed = true;
        })
      : "";
    if (overflowed)
      return {
        ok: false,
        error: `${label} answer exceeded ${HOOK_OUTPUT_MAX_BYTES} bytes`,
      };
    const text = body.trim();
    if (!text) return { ok: true };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: `${label} answered invalid JSON` };
    }
    if (!isRecord(value))
      return { ok: false, error: `${label} answer must be a JSON object` };
    return { ok: true, ...hookRecordOutput(value, target.ext, event) };
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? `${label} timed out after ${timeoutMs}ms`
        : `${label}: ${errorText(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs every command and url hook for one event in parallel. Decisions count
 * only on action events (gate mode) and combine deny > ask > allow; failures
 * go to the sink, which applies `on_failure`.
 */
export async function runCommandHooks(
  targets: readonly CommandHookTarget[],
  event: ExtensionEventBase,
  mode: DispatchMode,
  sink: CommandHookSink,
  options: CommandHookOptions = {},
): Promise<CommandHooksOutcome> {
  const results = await Promise.all(
    targets.map(({ hook, ...target }) =>
      typeof hook.url === "string"
        ? runUrlHook({ ...target, hook: hook as UrlHook }, event)
        : runCommandHook(
            { ...target, hook: hook as CommandHook },
            event,
            options,
          ),
    ),
  );
  const gates: DecidedGate[] = [];
  const rewrites: CommandHooksOutcome["rewrites"] = [];
  let answer: DispatchOutcome["answer"];
  for (const [index, result] of results.entries()) {
    const target = targets[index];
    if (!target) continue;
    if (!result.ok) {
      const failure = sink.fail(
        target.ext,
        result.error,
        target.hook.on_failure ?? "continue",
      );
      if (failure?.gate) gates.push(failure.gate);
      answer ??= failure?.answer;
      continue;
    }
    if (result.message) sink.log(target.ext, result.message);
    if (result.rewrite)
      rewrites.push({ ext: target.ext, rewrite: result.rewrite });
    if (result.gate && mode === "gate") gates.push(result.gate);
  }
  return {
    ...(gates.length ? { gate: combineGates(gates) } : {}),
    ...(answer ? { answer } : {}),
    rewrites,
  };
}
