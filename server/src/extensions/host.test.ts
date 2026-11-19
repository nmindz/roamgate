import { afterEach, expect, spyOn, test } from "bun:test";
import type { ToastSlotData } from "../../../shared/extensions";
import type { ExtensionHost } from "./host";
import { createAgentStatusEvents } from "./producers";
import { createExtensionSandbox } from "./test-fixtures";

let sandbox = createExtensionSandbox();
afterEach(async () => {
  await sandbox.cleanup();
  sandbox = createExtensionSandbox();
});

/** Resolves when the host's state satisfies `predicate`; checked on every change. */
function until(host: ExtensionHost, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const off = host.onChange(() => {
    if (!predicate()) return;
    off();
    resolve();
  });
  return promise;
}

function toasts() {
  const received: Array<ToastSlotData & { ext: string }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    received,
    toast(ext: string, toast: ToastSlotData) {
      received.push({ ...toast, ext });
      for (const waiter of waiters.splice(0)) {
        if (received.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    },
    count(count: number): Promise<void> {
      if (received.length >= count) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ count, resolve });
      return promise;
    },
  };
}

test("a busy-looping handler is abandoned within its budget while the bridge keeps ticking, then killed", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.spin",
    `export function register(on) {
      on("agent.status", () => { while (true) {} });
    }`,
    'activation = ["startup"]',
    registry,
  );
  const budget = 500;
  const { host, bus } = sandbox.host(registry, {
    budgets: { "agent.status": budget },
  });
  host.start();
  await until(host, () => host.isRunning("acme.spin"));

  // Real time on purpose: the bridge's own event loop must keep ticking
  // while the child spins, which fake timers cannot show.
  let ticks = 0;
  let longestGap = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
    ticks++;
  }, 10);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      const outcome = await bus.run({
        name: "agent.status",
        from: "working",
        to: "blocked",
      });
      const elapsed = performance.now() - started;
      expect(outcome.answer).toBeUndefined();
      expect(elapsed).toBeGreaterThanOrEqual(budget - 20);
      expect(elapsed).toBeLessThan(budget + 1_000);
    }
    expect(ticks).toBeGreaterThan(50);
    expect(longestGap).toBeLessThan(250);
    await until(host, () => !host.isRunning("acme.spin"));
  } finally {
    clearInterval(ticker);
  }
  expect(host.logs("acme.spin").map((line) => line.line)).toContainEqual(
    expect.stringContaining("killed: handlers ignored cancellation"),
  );
  expect(registry.get("acme.spin")?.failures).toHaveLength(3);
}, 20_000);

test("agent.status with a { to } matcher runs once per transition and carries the identities", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.blocked",
    `export function register(on, $) {
      on("agent.status", { to: "blocked" }, async ($, e) => {
        await $.ui.toast({ message: JSON.stringify(e) });
      });
    }`,
    'capabilities = ["ui"]\nactivation = ["event:agent.status"]',
    registry,
  );
  const seen = toasts();
  const { host, bus } = sandbox.host(registry, {
    dollar: { toast: seen.toast },
  });
  host.start();
  expect(host.isRunning("acme.blocked")).toBe(false);
  expect(bus.wants("agent.status")).toBe(true);

  const producer = createAgentStatusEvents({
    emit: (event) => bus.emit(event),
    connection: () => ({ id: "laptop", generation: 7 }),
  });
  const pane = {
    pane_id: "p1",
    workspace_id: "w1",
    tab_id: "t1",
    agent: "claude",
  };
  const status = (agent_status: string) => ({
    event: "pane.agent_status_changed",
    data: { ...pane, agent_status },
  });
  producer.reconcilePaneList({ panes: [{ ...pane, agent_status: "working" }] });
  producer.handleHerdrEvent(status("blocked"));
  producer.handleHerdrEvent(status("blocked"));
  await seen.count(1);
  producer.handleHerdrEvent(status("working"));
  producer.handleHerdrEvent(status("done"));
  producer.reconcilePaneList({ panes: [{ ...pane, agent_status: "done" }] });
  producer.handleHerdrEvent(status("blocked"));
  await seen.count(2);
  // Every event above was delivered before the last toast was answered.
  await bus.run({ name: "herdr.event" });

  const events = seen.received.map((toast) => JSON.parse(toast.message));
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    name: "agent.status",
    connection: { id: "laptop", generation: 7 },
    workspace_id: "w1",
    tab_id: "t1",
    pane_id: "p1",
    agent: "claude",
    from: "working",
    to: "blocked",
  });
  expect(events[1]).toMatchObject({ from: "done", to: "blocked" });
  expect(seen.received.every((toast) => toast.ext === "acme.blocked")).toBe(
    true,
  );
}, 20_000);

test("an extension activated only by its command shows the entry first and starts on run", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.lazy",
    `export function register(on) {
      on("command.run", { command: "hi" }, (_$, e) => ({ greeting: "hello", via: e.origin }));
    }`,
    `activation = ["command:hi"]

[[commands]]
id = "hi"
title = "Say hi"`,
    registry,
  );
  const spawn = spyOn(Bun, "spawn");
  const { host } = sandbox.host(registry);
  host.start();
  const entry = host.state().extensions[0];
  expect(entry).toMatchObject({
    id: "acme.lazy",
    status: "idle",
    contributions: { commands: [{ id: "hi", title: "Say hi" }] },
  });
  expect(host.isRunning("acme.lazy")).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
  spawn.mockRestore();
  const result = await host.runCommand("acme.lazy", "hi", {
    origin: "browser",
  });
  expect(result).toEqual({ greeting: "hello", via: "browser" });
  expect(host.isRunning("acme.lazy")).toBe(true);
  expect(host.state().extensions[0]?.status).toBe("active");
}, 20_000);

test("safe mode starts no extension process and lists every extension as safe mode", async () => {
  const registry = sandbox.registry({ safeModeFlag: true });
  sandbox.link(
    "acme.startup",
    "export function register() {}",
    'activation = ["startup"]',
    registry,
  );
  sandbox.link("acme.data", null, "", registry);
  const spawn = spyOn(Bun, "spawn");
  const { host, bus } = sandbox.host(registry);
  try {
    host.start();
    await bus.run({ name: "agent.status" });
    await bus.gate({ name: "pane.close" });
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
  expect(host.isRunning("acme.startup")).toBe(false);
  expect(bus.wants("agent.status")).toBe(false);
  expect(host.state()).toMatchObject({
    safe_mode: true,
    extensions: [
      { id: "acme.startup", status: "safe_mode" },
      { id: "acme.data", status: "safe_mode" },
    ],
  });
  await expect(host.runCommand("acme.startup", "x")).rejects.toThrow(
    "extension is not running",
  );
});

test("gates combine across extensions: deny beats allow, ask beats allow", async () => {
  const registry = sandbox.registry();
  const gate = (decision: string) =>
    `export function register(on) {
      on("pane.close", () => (${decision}));
    }`;
  sandbox.link(
    "acme.allow",
    gate('{ decision: "allow" }'),
    'activation = ["event:pane.close"]',
    registry,
  );
  sandbox.link(
    "acme.deny",
    gate('{ decision: "deny", reason: "agent is working" }'),
    'activation = ["event:pane.close"]',
    registry,
  );
  const { host, bus } = sandbox.host(registry);
  host.start();
  const denied = await bus.gate({ name: "pane.close", pane_id: "p1" });
  expect(denied.gate).toEqual({
    decision: "deny",
    reason: "agent is working",
    ext: "acme.deny",
  });

  registry.setEnabled("acme.deny", false);
  sandbox.link(
    "acme.ask",
    gate('{ decision: "ask", title: "Close it?" }'),
    'activation = ["event:pane.close"]',
    registry,
  );
  host.sync();
  const asked = await bus.gate({ name: "pane.close", pane_id: "p1" });
  expect(asked.gate).toMatchObject({
    decision: "ask",
    title: "Close it?",
    ext: "acme.ask",
    on_timeout: "deny",
  });
}, 20_000);

test("rewrites keep only rewritable fields; failures are fail-open unless the handler blocks", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.rewrite",
    `export function register(on) {
      on("terminal.submit", (_$, e, next) => next({ ...e, text: e.text + " [T-1]", pane_id: "other" }));
      on("pane.close", () => { throw new Error("boom"); });
    }`,
    'activation = ["event:terminal.submit", "event:pane.close"]',
    registry,
  );
  sandbox.link(
    "acme.strict",
    `export function register(on) {
      on("pane.split", () => { throw new Error("broken"); }, { onFailure: "block" });
    }`,
    'activation = ["event:pane.split"]',
    registry,
  );
  const { host, bus } = sandbox.host(registry);
  host.start();
  const submit = await bus.gate({
    name: "terminal.submit",
    pane_id: "p1",
    text: "fix it",
  });
  expect(submit.gate.decision).toBe("allow");
  expect(submit.event).toMatchObject({ text: "fix it [T-1]", pane_id: "p1" });
  const close = await bus.gate({ name: "pane.close", pane_id: "p1" });
  expect(close.gate.decision).toBe("allow");
  const split = await bus.gate({ name: "pane.split", pane_id: "p1" });
  expect(split.gate).toEqual({
    decision: "deny",
    reason: "extension error",
    ext: "acme.strict",
  });
  const logs = host.logs("acme.rewrite").map((line) => line.line);
  expect(logs).toContainEqual(
    expect.stringContaining("ignored changes to pane_id"),
  );
  expect(logs).toContainEqual(expect.stringContaining("rewrote text"));
  expect(logs).toContainEqual(expect.stringContaining("boom"));
}, 20_000);

test("repeated failures disable the extension and a crash never reaches the bridge", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.flaky",
    `export function register(on) {
      on("herdr.event", (_$, e) => {
        if (e.event === "crash") process.exit(3);
        throw new Error("bad " + e.event);
      });
    }`,
    'activation = ["event:herdr.event"]',
    registry,
  );
  let clock = Date.now();
  const { host, bus } = sandbox.host(registry, { now: () => clock });
  host.start();
  const crash = await bus.run({ name: "herdr.event", event: "crash" });
  expect(crash.answer).toBeUndefined();
  await until(host, () => !host.isRunning("acme.flaky"));
  expect(registry.get("acme.flaky")?.enabled).toBe(true);
  // Step past the restart backoff the crash set.
  clock += 60_000;
  for (let index = 0; index < 4; index++)
    await bus.run({ name: "herdr.event", event: `e${index}` });
  expect(registry.get("acme.flaky")).toMatchObject({
    enabled: false,
    auto_disabled: { error: "bad e3" },
  });
  expect(host.state().extensions[0]).toMatchObject({
    status: "failed",
    last_error: { message: "bad e3" },
  });
  expect(bus.wants("herdr.event")).toBe(false);
}, 20_000);

test("$.store persists through the child and enforces capabilities", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.store",
    `export function register(on) {
      on("command.run", { command: "count" }, async ($) => {
        const count = ((await $.store.get("count")) ?? 0) + 1;
        await $.store.set("count", count);
        let fetchError = null;
        try { await $.http.fetch("https://example.com"); } catch (error) { fetchError = error.message; }
        return { count, fetchError };
      });
    }`,
    `activation = ["command:count"]

[[commands]]
id = "count"
title = "Count"`,
    registry,
  );
  const first = sandbox.host(registry).host;
  first.start();
  expect(await first.runCommand("acme.store", "count")).toEqual({
    count: 1,
    fetchError:
      '$.http.fetch needs the "network" capability, which acme.store does not declare',
  });
  await first.dispose();
  const second = sandbox.host(sandbox.registry()).host;
  second.start();
  expect(await second.runCommand("acme.store", "count")).toMatchObject({
    count: 2,
  });
}, 20_000);
