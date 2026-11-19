import {
  EXTENSION_RPC_ERRORS,
  type Gate,
  gateRank,
} from "../../../shared/extensions";
import { ExtensionRpcError } from "./protocol";

/**
 * Built-in policy every extension is subject to. Extensions cannot configure,
 * gate or rewrite any of it.
 */

/** A gate with the extension that decided it; Roamgate's own gates have none. */
export type DecidedGate = Gate & { ext?: string };

export const ASK_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const ASK_MAX_TIMEOUT_MS = 24 * 60 * 60_000;
/** Longest ask texts; the approval service and the gate parser both clip to these. */
export const ASK_TEXT_LIMITS = {
  title: 200,
  body: 2_000,
  detail: 8_000,
  reason: 500,
} as const;

export class GuardError extends ExtensionRpcError {
  constructor(message: string) {
    super(EXTENSION_RPC_ERRORS.guard, message);
    this.name = "GuardError";
  }
}

/**
 * deny > ask > allow. A later allow never undoes an earlier deny or ask, and
 * among equal decisions the first (outermost) one is kept.
 */
export function combineGates(gates: readonly DecidedGate[]): DecidedGate {
  let decided: DecidedGate = { decision: "allow" };
  for (const gate of gates) {
    if (gateRank(gate.decision) > gateRank(decided.decision)) decided = gate;
  }
  return decided;
}

function clip(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

/**
 * Normalizes what a handler returned on an action event. Anything that is not
 * a recognizable gate is a handler failure, never an allow by accident.
 */
export function parseGate(value: unknown, ext?: string): DecidedGate {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("gate result must be an object with a decision");
  const record = value as Record<string, unknown>;
  const owner = ext === undefined ? {} : { ext };
  switch (record.decision) {
    case "allow":
      return { decision: "allow", ...owner };
    case "deny":
      return {
        decision: "deny",
        reason: clip(record.reason, ASK_TEXT_LIMITS.reason) || "denied",
        ...owner,
      };
    case "ask": {
      const title = clip(record.title, ASK_TEXT_LIMITS.title);
      if (!title) throw new Error("ask gates need a title");
      const timeout =
        typeof record.timeout_ms === "number" &&
        Number.isFinite(record.timeout_ms)
          ? Math.min(Math.max(1_000, record.timeout_ms), ASK_MAX_TIMEOUT_MS)
          : ASK_DEFAULT_TIMEOUT_MS;
      const risk =
        record.risk === "low" ||
        record.risk === "medium" ||
        record.risk === "high"
          ? record.risk
          : undefined;
      return {
        decision: "ask",
        title,
        body: clip(record.body, ASK_TEXT_LIMITS.body),
        detail: clip(record.detail, ASK_TEXT_LIMITS.detail),
        risk,
        timeout_ms: timeout,
        on_timeout: record.on_timeout === "allow" ? "allow" : "deny",
        ...owner,
      };
    }
    default:
      throw new Error('gate decision must be "allow", "deny" or "ask"');
  }
}

/** Contribution, command, route and slot ids: `<ext-id>:<local-id>` only. */
export function namespacedId(ext: string, localId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(localId))
    throw new GuardError(
      `ids use letters, digits, "_" and "-": ${JSON.stringify(localId)}`,
    );
  return `${ext}:${localId}`;
}

/** Refuses an id that names another extension's namespace. */
export function assertOwnNamespace(ext: string, id: string): string {
  const separator = id.indexOf(":");
  if (separator < 0) return namespacedId(ext, id);
  if (id.slice(0, separator) !== ext)
    throw new GuardError(
      `${ext} cannot use ${JSON.stringify(id)} outside its namespace`,
    );
  return namespacedId(ext, id.slice(separator + 1));
}

/**
 * `$` calls no extension may make, whatever its capabilities: answering asks
 * (only a person can), and managing extensions.
 */
const FORBIDDEN_CALLS = new Set([
  "ui.answer",
  "approvals.answer",
  "approval.answer",
  "extensions.enable",
  "extensions.disable",
  "extensions.install",
  "extensions.uninstall",
  "extensions.safe_mode",
  "extensions.order",
]);

export function assertDollarCallAllowed(ns: string, method: string): void {
  if (FORBIDDEN_CALLS.has(`${ns}.${method}`) || ns === "extensions")
    throw new GuardError(
      ns === "extensions"
        ? "extensions cannot manage extensions"
        : "only a person can answer an approval",
    );
}

/** Browser RPC methods outside every event, gate and rewrite. */
export function isUngateableMethod(method: string): boolean {
  return (
    method.startsWith("ext.") ||
    method === "bridge.ping" ||
    method === "terminal.input" ||
    method === "terminal.resize" ||
    method === "terminal.scroll"
  );
}

/**
 * Names of Roamgate credentials. They never reach a mod or a process an
 * extension starts, even when the service environment has them.
 */
const CREDENTIAL_ENV =
  /^(?:(?:ROAMGATE|HERDR_GUI)_(?:PASSWORD|PIN|TOKEN|AUTH_TOKEN|SESSION_SECRET|TLS_KEY|VAPID_PRIVATE_KEY)|BUN_INSPECT.*|NODE_OPTIONS|BUN_OPTIONS)$/i;

export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV.test(name);
}

/** Inherited variables a mod child may see; nothing else crosses over. */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "COMSPEC",
] as const;

/** The environment of an extension child or process: allowlisted, credential-free. */
export function extensionEnvironment(
  base: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = base[name];
    if (typeof value === "string") env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (isCredentialEnvName(name))
      throw new GuardError(`${name} cannot be passed to an extension process`);
    if (typeof value !== "string")
      throw new GuardError(`environment value for ${name} must be a string`);
    env[name] = value;
  }
  return env;
}
