import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_SUBMIT_TEXT_MAX } from "../../../shared/extensions";
import { gateRpcAction } from "./action-events";
import { createExtensionSandbox } from "./test-fixtures";

let sandbox = createExtensionSandbox();
afterEach(async () => {
  await sandbox.cleanup();
  sandbox = createExtensionSandbox();
});

const suffixMod = (suffix: string) => `export function register(on) {
  on("terminal.submit", async ($, e, next) => {
    await $.store.set("saw", e.text);
    return next({ ...e, text: e.text + ${JSON.stringify(suffix)} });
  });
}`;

test("chained terminal.submit rewrites follow the extension order, which changes without a restart", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.a",
    suffixMod(" [a]"),
    'activation = ["event:terminal.submit"]',
    registry,
  );
  sandbox.link(
    "acme.b",
    suffixMod(" [b]"),
    'activation = ["event:terminal.submit"]',
    registry,
  );
  const { host, bus } = sandbox.host(registry);
  host.start();
  const submit = async () =>
    (
      await gateRpcAction(
        { id: "local", generation: 1 },
        "pane.send_text",
        { pane_id: "w1:p1", text: "ls" },
        { bus },
      )
    ).text;

  expect(await submit()).toBe("ls [a] [b]");
  expect(host.logs("acme.a").map((line) => line.line)).toContainEqual(
    expect.stringContaining("terminal.submit: rewrote text"),
  );

  registry.setOrder(["acme.b", "acme.a"]);
  host.sync();
  expect(await submit()).toBe("ls [b] [a]");
}, 20_000);

test("an oversized rewrite is rejected, the original text goes on and the extension logs it", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.huge",
    `export function register(on) {
      on("terminal.submit", (_$, e, next) => next({ ...e, text: "x".repeat(${TERMINAL_SUBMIT_TEXT_MAX + 1}) }));
    }`,
    'activation = ["event:terminal.submit"]',
    registry,
  );
  const { host, bus } = sandbox.host(registry);
  host.start();
  const params = await gateRpcAction(
    { id: "local", generation: 1 },
    "pane.send_text",
    { pane_id: "w1:p1", text: "hello" },
    { bus },
  );
  expect(params.text).toBe("hello");
  expect(host.logs("acme.huge")).toContainEqual(
    expect.objectContaining({
      level: "error",
      line: expect.stringContaining("rewrite rejected, text is over"),
    }),
  );
}, 20_000);

test("an extension's own actions never reach its own handlers", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.self",
    `export function register(on) {
      on("pane.close", () => ({ decision: "deny", reason: "mine" }));
    }`,
    'activation = ["event:pane.close"]',
    registry,
  );
  const { host, bus } = sandbox.host(registry);
  host.start();
  const connection = { id: "local", generation: 1 };
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p" }, { bus }),
  ).rejects.toThrow("Denied by extension acme.self: mine");
  expect(
    await gateRpcAction(
      connection,
      "pane.close",
      { pane_id: "p" },
      { bus, origin: "extension:acme.self" },
    ),
  ).toEqual({ pane_id: "p" });
}, 20_000);

test("editing a linked mod reloads it, keeps its store and re-renders its slots", async () => {
  const registry = sandbox.registry();
  const mod = (reply: string) => `export function register(on) {
    on("command.run", async ($) => {
      const runs = ((await $.store.get("runs")) ?? 0) + 1;
      await $.store.set("runs", runs);
      return ${JSON.stringify(reply)} + runs;
    });
  }`;
  const dir = sandbox.link(
    "acme.live",
    mod("v1:"),
    '[[commands]]\nid = "go"\ntitle = "Go"',
    registry,
  );
  const invalidated: string[] = [];
  const reloaded = Promise.withResolvers<void>();
  const { host } = sandbox.host(registry, {
    watchLinks: true,
    dollar: {
      invalidate: (ext) => {
        invalidated.push(ext);
        reloaded.resolve();
      },
    },
  });
  host.start();
  expect(await host.runCommand("acme.live", "go")).toBe("v1:1");

  const started = performance.now();
  writeFileSync(join(dir, "mod.ts"), mod("v2:"));
  await reloaded.promise;
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(invalidated).toEqual(["acme.live"]);
  expect(await host.runCommand("acme.live", "go")).toBe("v2:2");
}, 20_000);
