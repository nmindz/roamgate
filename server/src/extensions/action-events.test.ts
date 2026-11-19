import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionEventBase } from "../../../shared/extensions";
import { silentLogger } from "../utils/logger";
import {
  ActionDeniedError,
  currentOrigin,
  gateRpcAction,
  installActionGate,
  interceptRpcCall,
  RPC_METHOD_ACTIONS,
  runWithOrigin,
  UNGATED_RPC_METHODS,
  UNGATED_RPC_PREFIXES,
} from "./action-events";
import {
  type DispatchMode,
  type DispatchOutcome,
  ExtensionBus,
} from "./events";
import type { DecidedGate } from "./guard";

const repo = join(import.meta.dir, "../../..");
let uninstall = () => {};
afterEach(() => uninstall());

/** A subscriber deciding every event it wants the same way, recording what it saw. */
function recordingBus(
  names: string[],
  decide: (event: ExtensionEventBase) => Partial<DispatchOutcome>,
) {
  const seen: Array<{ event: ExtensionEventBase; mode: DispatchMode }> = [];
  const bus = new ExtensionBus(silentLogger);
  bus.add({
    wants: (name) => names.includes(name),
    dispatch: async (event, mode) => {
      seen.push({ event, mode });
      return { event, ...decide(event) };
    },
  });
  uninstall = installActionGate(bus);
  return { bus, seen };
}

function methodsCalledFromSource(): Set<string> {
  const methods = new Set<string>();
  const sources = [
    ...new Bun.Glob("web/src/**/*.{ts,tsx}").scanSync({ cwd: repo }),
  ].filter((file) => !/\.test\.tsx?$/.test(file));
  for (const file of sources)
    for (const match of readFileSync(join(repo, file), "utf8").matchAll(
      /\b(?:request|call|rpc|send|invoke)[A-Za-z]*\(\s*"([a-z_]+\.[a-z_.]+)"/g,
    ))
      methods.add(match[1]!);
  for (const file of [
    ...new Bun.Glob(
      "server/src/{index.ts,bridge/*.ts,connections/*.ts}",
    ).scanSync({
      cwd: repo,
    }),
  ].filter((file) => !file.endsWith(".test.ts")))
    for (const match of readFileSync(join(repo, file), "utf8").matchAll(
      /method === "([a-z_]+\.[a-z_.]+)"/g,
    ))
      methods.add(match[1]!);
  return methods;
}

test("every RPC method is either mapped to an action event or explicitly ungated", () => {
  const methods = methodsCalledFromSource();
  expect(methods.size).toBeGreaterThan(50);
  const unclassified = [...methods].filter(
    (method) =>
      !Object.hasOwn(RPC_METHOD_ACTIONS, method) &&
      !UNGATED_RPC_METHODS.has(method) &&
      !UNGATED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix)),
  );
  expect(unclassified).toEqual([]);
  const both = Object.keys(RPC_METHOD_ACTIONS).filter((method) =>
    UNGATED_RPC_METHODS.has(method),
  );
  expect(both).toEqual([]);
  // Mutations a gate must always see, whatever new methods appear.
  expect(RPC_METHOD_ACTIONS).toMatchObject({
    "pane.send_text": "terminal.submit",
    "pane.send_input": "terminal.submit",
    "pane.send_keys": "terminal.keys",
    "pane.close": "pane.close",
    "tab.close": "tab.close",
    "workspace.close": "workspace.close",
    "pane.split": "pane.split",
    "tab.create": "tab.create",
    "workspace.create": "workspace.create",
    "worktree.create": "worktree.create",
    "worktree.remove": "worktree.remove",
    "file.mkdir": "file.write",
    "file.move": "file.write",
    "git.pull": "git.mutate",
    "git.file_action": "git.mutate",
    "git.repo_action": "git.mutate",
    "bridge.ui_settings.update": "settings.change",
  });
});

test("a deny names the extension and the reason; ungated paths pay nothing", async () => {
  const denied: DecidedGate = {
    decision: "deny",
    reason: "agent is working",
    ext: "acme.guard",
  };
  const { seen } = recordingBus(["pane.close"], () => ({ gate: denied }));
  const connection = { id: "laptop", generation: 3 };

  const error = await runWithOrigin("browser", () =>
    gateRpcAction(connection, "pane.close", { pane_id: "w1:p1" }),
  ).catch((caught) => caught);
  expect(error).toBeInstanceOf(ActionDeniedError);
  expect(error.message).toBe(
    "Denied by extension acme.guard: agent is working",
  );
  expect(seen[0]?.event).toMatchObject({
    name: "pane.close",
    origin: "browser",
    connection,
    pane_id: "w1:p1",
  });

  // No subscriber for tab.close: params come back unchanged at once.
  const params = { tab_id: "w1:t1" };
  expect(await gateRpcAction(connection, "tab.close", params)).toBe(params);
  expect(seen).toHaveLength(1);
});

test("an ask is denied when no approval service is installed", async () => {
  recordingBus(["worktree.remove"], () => ({
    gate: { decision: "ask", title: "Remove?", ext: "acme.ask" },
  }));
  await expect(
    gateRpcAction(undefined, "worktree.remove", { path: "/w" }),
  ).rejects.toThrow("Denied by extension acme.ask: approvals are unavailable");
});

test("a terminal.submit rewrite reaches the Herdr params", async () => {
  recordingBus(["terminal.submit"], (event) => ({
    event: { ...event, text: `${event.text} --verbose` },
    gate: { decision: "allow" },
  }));
  expect(
    await gateRpcAction({ id: "local", generation: 1 }, "pane.send_text", {
      pane_id: "w1:p1",
      text: "make test",
    }),
  ).toEqual({ pane_id: "w1:p1", text: "make test --verbose" });
});

test("origins follow the async call that set them", async () => {
  expect(currentOrigin()).toBe("browser");
  const seen = await runWithOrigin("ranger", async () => {
    await Promise.resolve();
    return runWithOrigin("extension:acme.x", async () => {
      await Promise.resolve();
      return currentOrigin();
    });
  });
  expect(seen).toBe("extension:acme.x");
  expect(await runWithOrigin("task", async () => currentOrigin())).toBe("task");
});

test("rpc.call handlers rewrite params, answer, or gate", async () => {
  let answer: unknown;
  const { bus } = recordingBus(["rpc.call"], (event) =>
    answer === undefined
      ? { event: { ...event, params: { ...(event.params as object), x: 1 } } }
      : { answer: { ext: "acme.rpc", value: answer } },
  );
  expect(await interceptRpcCall(undefined, "workspace.list", {}, bus)).toEqual({
    kind: "continue",
    params: { x: 1 },
  });
  answer = { cached: true };
  expect(await interceptRpcCall(undefined, "workspace.list", {}, bus)).toEqual({
    kind: "answer",
    result: { cached: true },
  });
  answer = { decision: "deny", reason: "read-only hours" };
  await expect(
    interceptRpcCall(undefined, "tab.rename", {}, bus),
  ).rejects.toThrow("Denied by extension acme.rpc: read-only hours");
});
