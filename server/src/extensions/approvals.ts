import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  ApprovalAnswerResult,
  ApprovalCause,
  ApprovalReceipt,
  EventOrigin,
  ExtensionEventBase,
  PendingApproval,
} from "../../../shared/extensions";
import {
  ASK_DEFAULT_TIMEOUT_MS,
  ASK_MAX_TIMEOUT_MS,
  ASK_TEXT_LIMITS,
  type DecidedGate,
} from "./guard";
import type { ReceiptStore } from "./receipts";

/**
 * Asks waiting for a person. Each ask is decided exactly once: by the first
 * answer from any browser, its timeout, or a cancellation (extension
 * disabled, safe mode, connection replaced). Every decision leaves one
 * receipt.
 */

export interface ApprovalConnection {
  id: string;
  generation: number;
}

export interface ApprovalRequest {
  ext: string;
  event: string;
  title: string;
  body?: string;
  detail?: string;
  risk?: "low" | "medium" | "high";
  timeout_ms?: number;
  on_timeout?: "deny" | "allow";
  origin: EventOrigin;
  connection?: ApprovalConnection;
  workspace_id?: string;
  tab_id?: string;
  pane_id?: string;
}

export interface ApprovalOutcome {
  id: string;
  decision: "allow" | "deny";
  cause: ApprovalCause;
  device: string | null;
}

export interface ApprovalServiceOptions {
  receipts?: ReceiptStore | null;
  /** Sends the full pending list to every browser after each change. */
  publish?: (approvals: PendingApproval[]) => void;
  /** Called once per new ask, e.g. to reach a phone when no browser is open. */
  announce?: (approval: PendingApproval) => void;
  /** Whether a connection generation is still the live one. */
  connectionCurrent?: (connection: ApprovalConnection) => boolean;
  now?: () => number;
}

interface Entry {
  approval: PendingApproval;
  connection?: ApprovalConnection;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: ApprovalOutcome) => void;
}

function clampTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return ASK_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), ASK_MAX_TIMEOUT_MS);
}

export class ApprovalService {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly options: ApprovalServiceOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  list(): PendingApproval[] {
    return [...this.entries.values()].map((entry) => entry.approval);
  }

  /** Opens an ask; `decided` settles once, however the ask ends. */
  request(input: ApprovalRequest): {
    approval: PendingApproval;
    decided: Promise<ApprovalOutcome>;
  } {
    const id = randomUUID();
    const createdAt = this.now();
    const timeoutMs = clampTimeout(input.timeout_ms);
    const approval: PendingApproval = {
      id,
      ext: input.ext,
      event: input.event,
      title: input.title.slice(0, ASK_TEXT_LIMITS.title),
      ...(input.body
        ? { body: input.body.slice(0, ASK_TEXT_LIMITS.body) }
        : {}),
      ...(input.detail
        ? { detail: input.detail.slice(0, ASK_TEXT_LIMITS.detail) }
        : {}),
      ...(input.risk ? { risk: input.risk } : {}),
      origin: input.origin,
      ...(input.connection ? { connection_id: input.connection.id } : {}),
      ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}),
      ...(input.tab_id ? { tab_id: input.tab_id } : {}),
      ...(input.pane_id ? { pane_id: input.pane_id } : {}),
      created_at: createdAt,
      expires_at: createdAt + timeoutMs,
      on_timeout: input.on_timeout === "allow" ? "allow" : "deny",
    };
    const { promise, resolve } = Promise.withResolvers<ApprovalOutcome>();
    if (this.disposed) {
      resolve({ id, decision: "deny", cause: "shutdown", device: null });
      return { approval, decided: promise };
    }
    const timer = setTimeout(
      () =>
        this.settle(
          id,
          approval.on_timeout === "allow" ? "allow" : "deny",
          "timed out",
          null,
        ),
      timeoutMs,
    );
    timer.unref?.();
    this.entries.set(id, {
      approval,
      connection: input.connection,
      timer,
      resolve,
    });
    pendingListener.getStore()?.(id);
    this.publish();
    this.options.announce?.(approval);
    return { approval, decided: promise };
  }

  /**
   * A person's answer. The first one wins; later ones learn it was decided.
   * An approval whose connection was replaced while waiting is denied.
   */
  answer(
    id: string,
    decision: "approve" | "deny",
    device: string | null = null,
  ): ApprovalAnswerResult {
    const entry = this.entries.get(id);
    if (!entry) return { already_decided: true };
    if (decision === "deny") this.settle(id, "deny", "denied", device);
    else if (
      entry.connection &&
      this.options.connectionCurrent &&
      !this.options.connectionCurrent(entry.connection)
    )
      this.settle(id, "deny", "connection changed", device);
    else this.settle(id, "allow", "approved", device);
    return { ok: true };
  }

  /** Denies every ask of one extension, e.g. when it is disabled. */
  cancelExtension(ext: string, cause: ApprovalCause): void {
    this.cancelWhere((entry) => entry.approval.ext === ext, cause);
  }

  /** Denies asks tied to a connection generation that is no longer live. */
  cancelStaleConnections(): void {
    const current = this.options.connectionCurrent;
    if (!current) return;
    this.cancelWhere(
      (entry) => !!entry.connection && !current(entry.connection),
      "connection changed",
    );
  }

  /** Re-checks pending asks against which extensions may still run. */
  reconcile(state: { safeMode: boolean; enabled: (ext: string) => boolean }) {
    if (state.safeMode) this.cancelWhere(() => true, "safe mode");
    else
      this.cancelWhere(
        (entry) => !state.enabled(entry.approval.ext),
        "extension disabled",
      );
  }

  dispose(): void {
    this.disposed = true;
    this.cancelWhere(() => true, "shutdown");
  }

  private cancelWhere(
    predicate: (entry: Entry) => boolean,
    cause: ApprovalCause,
  ): void {
    for (const [id, entry] of [...this.entries])
      if (predicate(entry)) this.settle(id, "deny", cause, null, false);
    this.publish();
  }

  private settle(
    id: string,
    decision: "allow" | "deny",
    cause: ApprovalCause,
    device: string | null,
    publish = true,
  ): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Removing the entry first is the per-ask mutex: nothing can decide it twice.
    this.entries.delete(id);
    clearTimeout(entry.timer);
    const { approval } = entry;
    const receipt: ApprovalReceipt = {
      id,
      ext: approval.ext,
      event: approval.event,
      title: approval.title,
      decision,
      cause,
      device,
      origin: approval.origin,
      connection_id: approval.connection_id ?? null,
      workspace_id: approval.workspace_id ?? null,
      pane_id: approval.pane_id ?? null,
      created_at: approval.created_at,
      decided_at: this.now(),
    };
    try {
      this.options.receipts?.append(receipt);
    } catch {
      // A failed receipt write must not leave the action hanging; it fails closed below.
      entry.resolve({ id, decision: "deny", cause, device });
      if (publish) this.publish();
      return;
    }
    entry.resolve({ id, decision, cause, device });
    if (publish) this.publish();
  }

  private publish(): void {
    this.options.publish?.(this.list());
  }
}

const pendingListener = new AsyncLocalStorage<(approvalId: string) => void>();

/**
 * Runs `fn` so that an ask opened inside it reports its id to `listener`;
 * the RPC path uses it to send the interim `pending` reply.
 */
export function withApprovalListener<T>(
  listener: (approvalId: string) => void,
  fn: () => T,
): T {
  return pendingListener.run(listener, fn);
}

let installed: ApprovalService | null = null;

/** The service asks are decided by; without one every ask is denied. */
export function installApprovals(service: ApprovalService): () => void {
  installed = service;
  return () => {
    if (installed === service) installed = null;
  };
}

/** Like withApprovalListener, for the rest of the current async call. */
export function listenForApprovals(listener: (approvalId: string) => void) {
  pendingListener.enterWith(listener);
}

export function installedApprovals(): ApprovalService | null {
  return installed;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Holds a gated action until a person decides its `ask`. */
export async function resolveAsk(
  gate: Extract<DecidedGate, { decision: "ask" }>,
  event: Partial<ExtensionEventBase> & { name: string },
  service: ApprovalService | null = installed,
): Promise<DecidedGate> {
  const ext = gate.ext ? { ext: gate.ext } : {};
  if (!service)
    return { decision: "deny", reason: "approvals are unavailable", ...ext };
  const { decided } = service.request({
    ext: gate.ext ?? "unknown",
    event: event.name,
    title: gate.title,
    body: gate.body,
    detail: gate.detail,
    risk: gate.risk,
    timeout_ms: gate.timeout_ms,
    on_timeout: gate.on_timeout,
    origin: event.origin ?? "browser",
    connection: event.connection,
    workspace_id: text(event.workspace_id),
    tab_id: text(event.tab_id),
    pane_id: text(event.pane_id),
  });
  const outcome = await decided;
  if (outcome.decision === "allow") return { decision: "allow", ...ext };
  return {
    decision: "deny",
    reason: outcome.cause === "denied" ? "denied by a person" : outcome.cause,
    ...ext,
  };
}
