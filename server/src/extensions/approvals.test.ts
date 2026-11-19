import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionEventBase,
  PendingApproval,
} from "../../../shared/extensions";
import { silentLogger } from "../utils/logger";
import {
  ActionDeniedError,
  gatePaneInput,
  gateRpcAction,
  installActionGate,
  runWithOrigin,
} from "./action-events";
import {
  ApprovalService,
  installApprovals,
  withApprovalListener,
} from "./approvals";
import { ExtensionBus } from "./events";
import {
  assertDollarCallAllowed,
  combineGates,
  type DecidedGate,
} from "./guard";
import {
  openReceiptStore,
  RECEIPT_MAX_ROWS,
  type ReceiptStore,
} from "./receipts";
import { createInvalidateCoalescer } from "./rpc";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function receipts(now?: () => number): ReceiptStore {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-receipts-"));
  const store = openReceiptStore(join(dir, "receipts.sqlite"), {
    now,
    pruneEveryMs: null,
  });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

/** Installs a bus whose only subscriber gates `names` with `gate`, plus an approval service. */
function gatedBridge(
  names: string[],
  gate: DecidedGate,
  options: { connectionCurrent?: () => boolean } = {},
) {
  const bus = new ExtensionBus(silentLogger);
  bus.add({
    wants: (name) => names.includes(name),
    dispatch: async (event: ExtensionEventBase) => ({ event, gate }),
  });
  const pushes: PendingApproval[][] = [];
  const store = receipts();
  const approvals = new ApprovalService({
    receipts: store,
    publish: (list) => pushes.push(list),
    connectionCurrent: options.connectionCurrent,
  });
  const offGate = installActionGate(bus);
  const offApprovals = installApprovals(approvals);
  cleanups.push(() => {
    offGate();
    offApprovals();
    approvals.dispose();
  });
  return { approvals, pushes, store };
}

/** Resolves once an ask is open, with its id. */
function nextAsk(approvals: ApprovalService): Promise<string> {
  return (async () => {
    for (let tries = 0; tries < 1_000; tries++) {
      const [pending] = approvals.list();
      if (pending) return pending.id;
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("no ask opened");
  })();
}

const ask: DecidedGate = {
  decision: "ask",
  title: "Close pane?",
  ext: "acme.guard",
};

test("AC-01-14: first answer wins, every browser sees it close, one receipt names the device", async () => {
  const { approvals, pushes, store } = gatedBridge(["pane.close"], ask);
  let ran = 0;
  const action = gateRpcAction({ id: "c1", generation: 1 }, "pane.close", {
    pane_id: "p1",
  }).then(() => ran++);
  const id = await nextAsk(approvals);
  expect(pushes.at(-1)?.map((entry) => entry.id)).toEqual([id]);
  expect(approvals.answer(id, "approve", "phone")).toEqual({ ok: true });
  expect(approvals.answer(id, "approve", "laptop")).toEqual({
    already_decided: true,
  });
  await action;
  expect(ran).toBe(1);
  // The empty list pushed to all browsers closes the other card.
  expect(pushes.at(-1)).toEqual([]);
  const rows = store.list();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id,
    decision: "allow",
    cause: "approved",
    device: "phone",
    ext: "acme.guard",
    event: "pane.close",
    pane_id: "p1",
  });
});

test("AC-01-15: an unanswered ask times out as a deny; disabling the extension denies with that cause", async () => {
  const { approvals, store } = gatedBridge(["pane.close"], {
    ...ask,
    // A real short timeout: the service owns its timer.
    timeout_ms: 15,
  } as DecidedGate);
  await expect(
    gateRpcAction(undefined, "pane.close", { pane_id: "p1" }),
  ).rejects.toThrow("Denied by extension acme.guard: timed out");
  expect(store.list()[0]).toMatchObject({
    decision: "deny",
    cause: "timed out",
  });

  const pending = gateRpcAction(undefined, "pane.close", { pane_id: "p2" });
  await nextAsk(approvals);
  approvals.reconcile({ safeMode: false, enabled: () => false });
  await expect(pending).rejects.toThrow("extension disabled");
  expect(store.list()[0]).toMatchObject({ cause: "extension disabled" });

  const safe = gateRpcAction(undefined, "pane.close", { pane_id: "p3" });
  await nextAsk(approvals);
  approvals.reconcile({ safeMode: true, enabled: () => true });
  await expect(safe).rejects.toThrow("safe mode");
});

test("an ask may allow on timeout when the gate says so, capped at 24 h", () => {
  const approvals = new ApprovalService();
  cleanups.push(() => approvals.dispose());
  const { approval } = approvals.request({
    ext: "a",
    event: "pane.close",
    title: "t",
    origin: "browser",
    timeout_ms: 7 * 24 * 60 * 60_000,
    on_timeout: "allow",
  });
  expect(approval.expires_at - approval.created_at).toBe(24 * 60 * 60_000);
  expect(approval.on_timeout).toBe("allow");
});

test("AC-01-16: deny beats allow, ask beats allow, and a mod cannot answer an ask", () => {
  expect(
    combineGates([
      { decision: "allow", ext: "a" },
      { decision: "deny", reason: "no", ext: "b" },
    ]).decision,
  ).toBe("deny");
  expect(
    combineGates([
      { decision: "ask", title: "?", ext: "a" },
      { decision: "allow", ext: "b" },
    ]).decision,
  ).toBe("ask");
  for (const [ns, method] of [
    ["ui", "answer"],
    ["approvals", "answer"],
    ["approval", "answer"],
  ])
    expect(() => assertDollarCallAllowed(ns!, method!)).toThrow(
      "only a person can answer an approval",
    );
});

test("AC-01-17: Ranger's send_prompt waits at the ask and runs only after approval", async () => {
  const { approvals } = gatedBridge(["terminal.submit"], ask);
  let delivered: string | null = null;
  const sending = runWithOrigin("ranger", () =>
    gatePaneInput({ id: "c1", generation: 1 }, { pane_id: "p1" }, "deploy"),
  ).then((text) => {
    delivered = text;
  });
  const id = await nextAsk(approvals);
  expect(approvals.list()[0]?.origin).toBe("ranger");
  expect(delivered).toBeNull();
  approvals.answer(id, "approve", "phone");
  await sending;
  expect(delivered as string | null).toBe("deploy");
});

test("AC-01-18: approval after the connection was replaced does not run and records it", async () => {
  let current = true;
  const { approvals, store } = gatedBridge(["pane.close"], ask, {
    connectionCurrent: () => current,
  });
  const action = gateRpcAction({ id: "c1", generation: 1 }, "pane.close", {
    pane_id: "p1",
  });
  const id = await nextAsk(approvals);
  current = false;
  approvals.answer(id, "approve", "phone");
  const error = await action.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ActionDeniedError);
  expect((error as Error).message).toContain("connection changed");
  expect(store.list()[0]).toMatchObject({
    decision: "deny",
    cause: "connection changed",
    device: "phone",
  });
});

test("connection replacement cancels asks tied to the old generation", async () => {
  let current = true;
  const { approvals } = gatedBridge(["pane.close"], ask, {
    connectionCurrent: () => current,
  });
  const action = gateRpcAction({ id: "c1", generation: 1 }, "pane.close", {});
  await nextAsk(approvals);
  current = false;
  approvals.cancelStaleConnections();
  await expect(action).rejects.toThrow("connection changed");
});

test("an RPC that opens an ask reports its approval id for the interim reply", async () => {
  const { approvals } = gatedBridge(["pane.close"], ask);
  const announced: string[] = [];
  const action = withApprovalListener(
    (approvalId) => announced.push(approvalId),
    () => gateRpcAction(undefined, "pane.close", {}),
  );
  const id = await nextAsk(approvals);
  expect(announced).toEqual([id]);
  approvals.answer(id, "deny");
  await expect(action).rejects.toThrow("denied by a person");
});

test("receipts prune to 30 days and 10,000 rows, newest first, filtered by extension", () => {
  let now = 40 * 24 * 60 * 60_000;
  const store = receipts(() => now);
  const row = (id: string, ext: string, at: number) => ({
    id,
    ext,
    event: "pane.close",
    title: "t",
    decision: "deny" as const,
    cause: "denied" as const,
    device: null,
    origin: "browser",
    connection_id: null,
    workspace_id: null,
    pane_id: null,
    created_at: at,
    decided_at: at,
  });
  store.append(row("old", "a", 1));
  store.append(row("new", "b", now - 1));
  for (let index = 0; index < RECEIPT_MAX_ROWS; index++)
    store.append(row(`r${index}`, "a", now));
  store.prune();
  expect(store.list({ limit: 1_000 }).some((entry) => entry.id === "old")).toBe(
    false,
  );
  expect(store.list({ ext: "b" })).toHaveLength(0);
  expect(store.list({ ext: "a", limit: 5 })).toHaveLength(5);
  now += 1;
  expect(store.list({ before: now - 1, limit: 1 })).toHaveLength(0);
});

test("invalidations coalesce per ext x slot to one trailing push per interval", async () => {
  const sent: string[] = [];
  const invalidate = createInvalidateCoalescer(
    (ext, slot) => sent.push(`${ext}:${slot}`),
    10,
  );
  for (let index = 0; index < 50; index++) invalidate("a", "workspace.badge");
  invalidate("b", "workspace.badge");
  expect(sent).toEqual(["a:workspace.badge", "b:workspace.badge"]);
  // Real time: the coalescer's own interval timer flushes the trailing push.
  await Bun.sleep(15);
  expect(sent).toEqual([
    "a:workspace.badge",
    "b:workspace.badge",
    "a:workspace.badge",
  ]);
});
