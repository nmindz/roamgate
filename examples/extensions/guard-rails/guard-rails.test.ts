// Run with `roamgate ext test examples/extensions/guard-rails`.
import { afterEach, expect, test } from "bun:test";
import { createFakeHost, type FakeHost } from "roamgate:testing";

let host: FakeHost | undefined;
afterEach(() => host?.close());

const agents = {
  agents: [{ pane_id: "w1:p1", agent: "claude", status: "working" }],
};

test("closing a pane with a working agent is denied", async () => {
  host = await createFakeHost({
    dir: import.meta.dir,
    stubs: { "roamgate.agents": agents },
  });
  expect(await host.gate({ name: "pane.close", pane_id: "w1:p1" })).toEqual({
    decision: "deny",
    reason: "claude is still working",
  });
  expect(await host.gate({ name: "pane.close", pane_id: "w1:p2" })).toEqual({
    decision: "allow",
  });
});

test("text for a protected workspace asks first", async () => {
  host = await createFakeHost({
    dir: import.meta.dir,
    stubs: {
      "roamgate.workspaces": {
        workspaces: [{ workspace_id: "w1", label: "prod-api" }],
      },
    },
  });
  expect(
    await host.gate({
      name: "terminal.submit",
      workspace_id: "w1",
      text: "deploy",
      mode: "text",
    }),
  ).toMatchObject({ decision: "ask", title: "Send to prod-api?" });
});

test("a forced worktree removal fails closed", async () => {
  host = await createFakeHost({ dir: import.meta.dir });
  expect(
    await host.gate({ name: "worktree.remove", path: "/w", force: true }),
  ).toEqual({ decision: "deny", reason: "extension error" });
});
