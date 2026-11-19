import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { addListener } from "../../../shared/listeners";
import { bridge } from "../api";
import { ExtIcon } from "./icons";
import type { ApprovalDecision, PendingApproval } from "./types";
import { useExtensionsState } from "./state";

// First answer wins: the bridge's next push drops the answered ask, which
// closes its card in every other browser.

let approvals: readonly PendingApproval[] = [];
let started = false;
const listeners = new Set<() => void>();

export function isApproval(value: unknown): value is PendingApproval {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PendingApproval>;
  return (
    typeof item.id === "string" &&
    typeof item.ext === "string" &&
    typeof item.summary === "string" &&
    !!item.target &&
    typeof item.target === "object"
  );
}

export function setApprovals(next: unknown) {
  approvals = Array.isArray(next) ? next.filter(isApproval) : [];
  listeners.forEach((listener) => listener());
}

function removeApproval(id: string) {
  setApprovals(approvals.filter((item) => item.id !== id));
}

function refresh() {
  bridge.call("ext.approval.list").then(
    (result) =>
      setApprovals(Array.isArray(result) ? result : result?.approvals),
    () => {},
  );
}

export function startApprovals() {
  if (started) return;
  started = true;
  bridge.onExtensions((push) => {
    if ("approvals" in push) setApprovals(push.approvals);
  });
  bridge.onStatus((status) => status === "connected" && refresh());
}

export function resetApprovals() {
  approvals = [];
  started = false;
  listeners.forEach((listener) => listener());
}

export function usePendingApprovals(): readonly PendingApproval[] {
  startApprovals();
  return useSyncExternalStore(
    (listener) => addListener(listeners, listener),
    () => approvals,
  );
}

/** Answers an ask. The card closes on any reply, `already_decided` included. */
export async function answerApproval(id: string, decision: ApprovalDecision) {
  const result = await bridge.call("ext.approval.answer", { id, decision });
  removeApproval(id);
  return result;
}

function timeLeft(deadline: number | undefined, now: number) {
  if (deadline === undefined) return null;
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function ApprovalCard({
  approval,
  extName,
}: {
  approval: PendingApproval;
  extName: string;
}) {
  const titleId = useId();
  const bodyId = useId();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useNow(approval.deadline !== undefined);
  const left = timeLeft(approval.deadline, now);
  const decide = (decision: ApprovalDecision) => {
    setBusy(true);
    setError("");
    answerApproval(approval.id, decision).catch((e: unknown) => {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  const target = [
    approval.target.connection_label ?? approval.target.connection_id,
    approval.target.workspace_label ?? approval.target.workspace_id,
    approval.target.pane_id,
  ].filter(Boolean);
  return (
    <section
      className={`ext-approval ext-risk-${approval.risk ?? "medium"}`}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-approval-id={approval.id}
    >
      <header>
        <ExtIcon name="shield-check" size={16} />
        <strong id={titleId}>
          {extName} asks to {approval.summary}
        </strong>
        {approval.risk ? (
          <span className="badge ext-chip">{approval.risk} risk</span>
        ) : null}
      </header>
      <dl id={bodyId} className="ext-approval-facts">
        {target.length > 0 ? (
          <>
            <dt>Target</dt>
            <dd>{target.join(" / ")}</dd>
          </>
        ) : null}
        <dt>Origin</dt>
        <dd>{approval.origin}</dd>
        {approval.reason ? (
          <>
            <dt>Reason</dt>
            <dd>{approval.reason}</dd>
          </>
        ) : null}
      </dl>
      {approval.detail ? (
        <details className="ext-approval-detail">
          <summary>Details</summary>
          <pre>{approval.detail}</pre>
        </details>
      ) : null}
      {left ? (
        <p className="muted" role="timer" aria-live="off">
          {left} left; then {approval.on_timeout ?? "deny"}
        </p>
      ) : null}
      {error ? (
        <p className="ext-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="ext-actions">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={() => decide("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => decide("approve")}
        >
          Approve
        </button>
      </div>
    </section>
  );
}

export function useExtensionNames(): Map<string, string> {
  const state = useExtensionsState();
  return new Map(state?.extensions.map((entry) => [entry.id, entry.name]));
}

/** Cards for the asks that target one pane of the active connection. */
export function PaneApprovals({
  paneId,
  connectionId,
}: {
  paneId: string;
  connectionId?: string;
}) {
  const list = usePendingApprovals();
  const names = useExtensionNames();
  const mine = list.filter(
    (item) =>
      item.target.pane_id === paneId &&
      (!connectionId ||
        !item.target.connection_id ||
        item.target.connection_id === connectionId),
  );
  if (mine.length === 0) return null;
  return (
    <div className="ext-pane-approvals">
      {mine.map((item) => (
        <ApprovalCard
          key={item.id}
          approval={item}
          extName={names.get(item.ext) ?? item.ext}
        />
      ))}
    </div>
  );
}
