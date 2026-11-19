import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { gateRpcAction, runWithOrigin } from "./action-events";
import { ApprovalService, installApprovals } from "./approvals";
import type { DollarConnectionLease } from "./dollar";
import { createExtensionSandbox } from "./test-fixtures";

const example = join(
  import.meta.dir,
  "../../../examples/extensions/guard-rails",
);
const sandbox = createExtensionSandbox();
afterEach(() => sandbox.cleanup());

function guardRails() {
  const registry = sandbox.registry();
  registry.add({
    id: "roamgate.guard-rails",
    source: { kind: "link", location: example },
    version: "1.0.0",
    path: example,
    enabled: true,
  });
  const lease: DollarConnectionLease = {
    connectionId: "c1",
    generation: 1,
    isCurrent: () => true,
    call: async (method) => {
      if (method === "agent.list")
        return {
          agents: [{ pane_id: "p1", agent: "claude", status: "working" }],
        };
      if (method === "workspace.list")
        return {
          workspaces: [
            { workspace_id: "w-prod", label: "api-prod" },
            { workspace_id: "w-dev", label: "api-dev" },
          ],
        };
      throw new Error(`unexpected ${method}`);
    },
  };
  const { host, bus } = sandbox.host(registry, {
    readConfig: async () => ({ protected_pattern: "prod" }),
    dollar: { lease: () => lease },
  });
  host.start();
  return { bus };
}

const connection = { id: "c1", generation: 1 };

test("AC-01-13: closing a working agent's pane is denied for the browser and for Ranger", async () => {
  const { bus } = guardRails();
  const message =
    "Denied by extension roamgate.guard-rails: claude is still working";
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
  ).rejects.toThrow(message);
  await expect(
    runWithOrigin("ranger", () =>
      gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
    ),
  ).rejects.toThrow(message);
  const idle = { pane_id: "p2" };
  expect(await gateRpcAction(connection, "pane.close", idle, { bus })).toBe(
    idle,
  );
});

test("guard-rails asks before sending to a protected workspace and fails closed", async () => {
  const { bus } = guardRails();
  const asked: string[] = [];
  const approvals = new ApprovalService({
    announce: (pending) => {
      asked.push(pending.title);
      approvals.answer(pending.id, "approve", "test");
    },
  });
  const off = installApprovals(approvals);
  try {
    const sent = { workspace_id: "w-prod", pane_id: "p9", text: "deploy" };
    expect(
      await gateRpcAction(connection, "pane.send_text", sent, { bus }),
    ).toEqual(sent);
    expect(asked).toEqual(["Send to api-prod?"]);
    const dev = { workspace_id: "w-dev", pane_id: "p9", text: "ls" };
    await gateRpcAction(connection, "pane.send_text", dev, { bus });
    expect(asked).toHaveLength(1);
    await expect(
      gateRpcAction(
        connection,
        "worktree.remove",
        { path: "/w", force: true },
        { bus },
      ),
    ).rejects.toThrow("Denied by extension roamgate.guard-rails");
  } finally {
    off();
    approvals.dispose();
  }
});
