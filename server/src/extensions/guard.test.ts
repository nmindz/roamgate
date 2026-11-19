import { expect, test } from "bun:test";
import type { ExtensionManifest } from "../../../shared/extensions";
import { EXTENSION_RPC_ERRORS } from "../../../shared/extensions";
import { silentLogger } from "../utils/logger";
import { createDollarDispatcher } from "./dollar";
import {
  type DispatchMode,
  type DispatchOutcome,
  type EventSubscriber,
  ExtensionBus,
} from "./events";
import {
  assertOwnNamespace,
  combineGates,
  extensionEnvironment,
  parseGate,
} from "./guard";
import { extensionPaths } from "./paths";
import { ExtensionStore } from "./store";

function gateSubscriber(
  value: DispatchOutcome["gate"],
  calls: string[] = [],
): EventSubscriber {
  return {
    wants: (name) => name === "pane.close",
    async dispatch(event, mode: DispatchMode) {
      calls.push(mode);
      return { event, gate: value };
    },
  };
}

test("one allow and one deny deny the action; one ask and one allow ask", async () => {
  const bus = new ExtensionBus(silentLogger);
  bus.add(gateSubscriber({ decision: "allow", ext: "a" }));
  bus.add(gateSubscriber({ decision: "deny", reason: "no", ext: "b" }));
  expect((await bus.gate({ name: "pane.close" })).gate).toEqual({
    decision: "deny",
    reason: "no",
    ext: "b",
  });

  const asking = new ExtensionBus(silentLogger);
  asking.add(gateSubscriber({ decision: "ask", title: "Sure?", ext: "a" }));
  asking.add(gateSubscriber({ decision: "allow", ext: "b" }));
  expect((await asking.gate({ name: "pane.close" })).gate).toEqual({
    decision: "ask",
    title: "Sure?",
    ext: "a",
  });
});

test("a later allow never undoes an earlier deny or ask", () => {
  expect(
    combineGates([
      { decision: "deny", reason: "guard" },
      { decision: "allow", ext: "x" },
      { decision: "ask", title: "t", ext: "y" },
    ]),
  ).toEqual({ decision: "deny", reason: "guard" });
  expect(combineGates([])).toEqual({ decision: "allow" });
});

test("gates without subscribers return synchronously; a broken subscriber never blocks", async () => {
  const bus = new ExtensionBus(silentLogger);
  const quiet = bus.gate({ name: "pane.close", pane_id: "p" });
  expect(quiet).not.toBeInstanceOf(Promise);
  expect((quiet as { gate: unknown }).gate).toEqual({ decision: "allow" });
  bus.add({
    wants: () => true,
    dispatch: async () => {
      throw new Error("subscriber bug");
    },
  });
  expect((await bus.gate({ name: "pane.close" })).gate.decision).toBe("allow");
  expect(() => bus.gate({ name: "agent.status" })).toThrow(
    "not an action event",
  );
});

test("gate results must be recognizable; asks get bounded timeouts", () => {
  expect(() => parseGate(true)).toThrow();
  expect(() => parseGate({ decision: "maybe" })).toThrow();
  expect(() => parseGate({ decision: "ask" })).toThrow("title");
  expect(parseGate({ decision: "deny" }, "x")).toEqual({
    decision: "deny",
    reason: "denied",
    ext: "x",
  });
  expect(
    parseGate({ decision: "ask", title: "t", timeout_ms: 10 ** 12 }),
  ).toMatchObject({ timeout_ms: 24 * 60 * 60_000, on_timeout: "deny" });
});

test("an extension cannot answer an ask or manage extensions through $", async () => {
  const manifest = {
    capabilities: ["ui", "gates"],
    network_hosts: [],
  } as unknown as ExtensionManifest;
  const dollar = createDollarDispatcher({
    ext: "acme.self",
    manifest,
    root: "/",
    store: new ExtensionStore(extensionPaths("/nonexistent"), "acme.self"),
    host: {
      lease: () => null,
      connections: () => [],
      notify: () => undefined,
      toast: () => undefined,
      invalidate: () => undefined,
      bus: new ExtensionBus(silentLogger),
    },
  });
  for (const [ns, method] of [
    ["ui", "answer"],
    ["approvals", "answer"],
    ["extensions", "disable"],
    ["extensions", "safe_mode"],
  ] as const) {
    await expect(dollar.call(ns, method, [])).rejects.toMatchObject({
      code: EXTENSION_RPC_ERRORS.guard,
    });
  }
});

test("namespaces and credentials are enforced", () => {
  expect(assertOwnNamespace("acme.a", "rerun")).toBe("acme.a:rerun");
  expect(assertOwnNamespace("acme.a", "acme.a:rerun")).toBe("acme.a:rerun");
  expect(() => assertOwnNamespace("acme.a", "acme.b:rerun")).toThrow(
    "outside its namespace",
  );
  const env = extensionEnvironment(
    {
      PATH: "/bin",
      HOME: "/home/u",
      ROAMGATE_PASSWORD: "secret",
      ROAMGATE_PIN: "123456",
      AWS_SECRET_ACCESS_KEY: "x",
    },
    { ROAMGATE_EXTENSION_ID: "acme.a" },
  );
  expect(env).toEqual({
    PATH: "/bin",
    HOME: "/home/u",
    ROAMGATE_EXTENSION_ID: "acme.a",
  });
  expect(() => extensionEnvironment({}, { ROAMGATE_PASSWORD: "x" })).toThrow();
  expect(() => extensionEnvironment({}, { HERDR_GUI_PIN: "1" })).toThrow();
});
