import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTENSION_RPC_ERRORS,
  type ExtensionManifest,
} from "../../../shared/extensions";
import { silentLogger } from "../utils/logger";
import {
  createDollarDispatcher,
  type DollarConnectionLease,
  type DollarHost,
} from "./dollar";
import { ExtensionBus } from "./events";
import { hostMatches } from "./manifest";
import { extensionPaths } from "./paths";
import { ExtensionStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function setup(
  capabilities: string[],
  host: Partial<DollarHost> = {},
  networkHosts: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), "roamgate-dollar-"));
  roots.push(root);
  const paths = extensionPaths(join(root, "extensions"));
  const store = new ExtensionStore(paths, "acme.test");
  const bus = host.bus ?? new ExtensionBus(silentLogger);
  const dollar = createDollarDispatcher({
    ext: "acme.test",
    manifest: {
      capabilities,
      network_hosts: networkHosts,
    } as unknown as ExtensionManifest,
    store,
    root,
    host: {
      lease: () => null,
      connections: () => [],
      notify: () => undefined,
      toast: () => undefined,
      invalidate: () => undefined,
      ...host,
      bus,
    },
  });
  return { root, paths, store, bus, dollar };
}

test("$.store survives a new instance and refuses writes over its limit, keeping the old value", async () => {
  const { paths, dollar } = setup([]);
  await dollar.call("store", "set", ["greeting", { text: "hi" }]);
  expect(await dollar.call("store", "keys", [])).toEqual(["greeting"]);
  const reopened = new ExtensionStore(paths, "acme.test");
  expect(reopened.get("greeting")).toEqual({ text: "hi" });

  const small = new ExtensionStore(paths, "acme.test", 64);
  expect(() => small.set("big", "x".repeat(100))).toThrow(
    "store size limit exceeded",
  );
  expect(small.get("big")).toBeNull();
  expect(
    JSON.parse(readFileSync(paths.storeFile("acme.test"), "utf8")),
  ).toEqual({ greeting: { text: "hi" } });
  expect(await dollar.call("store", "delete", ["greeting"])).toBe(true);
  expect(await dollar.call("store", "get", ["greeting"])).toBeNull();
});

test("calls outside declared capabilities fail with a capability error", async () => {
  const { dollar } = setup(["ui"]);
  for (const [ns, method, args] of [
    ["process", "run", [["true"]]],
    ["http", "fetch", ["https://example.com"]],
    ["terminal", "send", ["p1", "hi"]],
    ["herdr", "call", [undefined, "pane.close", {}]],
    ["herdr", "call", [undefined, "pane.list", {}]],
    ["roamgate", "workspaces", []],
    ["notify", "push", [{ title: "t" }]],
  ] as const) {
    await expect(
      dollar.call(ns, method, args as unknown as unknown[]),
    ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.capability });
  }
  await expect(dollar.call("nope", "x", [])).rejects.toMatchObject({
    code: EXTENSION_RPC_ERRORS.methodNotFound,
  });
});

test("$.process.run takes argv only, hides credentials, caps output and times out", async () => {
  const { dollar, root } = setup(["process"]);
  const previous = process.env.ROAMGATE_PASSWORD;
  process.env.ROAMGATE_PASSWORD = "do-not-leak";
  try {
    const result = (await dollar.call("process", "run", [
      [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({ cwd: process.cwd(), pw: process.env.ROAMGATE_PASSWORD ?? null, extra: process.env.EXTRA }))",
      ],
      { env: { EXTRA: "1" } },
    ])) as { code: number; stdout: string };
    expect(result.code).toBe(0);
    const seen = JSON.parse(result.stdout);
    expect(seen).toEqual({ cwd: seen.cwd, pw: null, extra: "1" });
    expect(seen.cwd.endsWith(root.split("/").pop() ?? "")).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.ROAMGATE_PASSWORD;
    else process.env.ROAMGATE_PASSWORD = previous;
  }
  await expect(
    dollar.call("process", "run", [
      ["sh", "-c", "echo hi"],
      { env: { ROAMGATE_PIN: "1" } },
    ]),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.guard });
  await expect(
    dollar.call("process", "run", ["echo hi"]),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.invalidParams });
  const big = (await dollar.call("process", "run", [
    [
      process.execPath,
      "-e",
      "process.stdout.write('x'.repeat(5 * 1024 * 1024))",
    ],
  ])) as { stdout: string; truncated?: boolean };
  expect(big.truncated).toBe(true);
  expect(big.stdout.length).toBe(4 * 1024 * 1024);
  await expect(
    dollar.call("process", "run", [
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { timeout: 200 },
    ]),
  ).rejects.toThrow("timed out after 200ms");
}, 20_000);

test("$.process.run with a connection refuses local and Windows connections clearly", async () => {
  const lease = (overrides: Partial<DollarConnectionLease>) => ({
    connectionId: "c",
    generation: 1,
    isCurrent: () => true,
    call: async () => null,
    ...overrides,
  });
  const local = setup(["process.remote"], { lease: () => lease({}) });
  await expect(
    local.dollar.call("process", "run", [["ls"], { connection: "c" }]),
  ).rejects.toThrow("local connection");
  const windows = setup(["process.remote"], {
    lease: () => lease({ sshHost: "box", remotePlatform: "windows" }),
  });
  await expect(
    windows.dollar.call("process", "run", [["ls"], { connection: "c" }]),
  ).rejects.toThrow("unsupported on this connection");
});

test("$.http.fetch follows at most five redirects within network_hosts and caps bodies", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const hop = Number(url.searchParams.get("hop") ?? 0);
      if (url.pathname === "/chain")
        return hop < Number(url.searchParams.get("to"))
          ? Response.redirect(
              `/chain?hop=${hop + 1}&to=${url.searchParams.get("to")}`,
              302,
            )
          : new Response(`landed ${hop}`);
      if (url.pathname === "/away")
        return Response.redirect("http://localhost:1/x", 302);
      if (url.pathname === "/big")
        return new Response("x".repeat(5 * 1024 * 1024));
      return new Response("ok", { headers: { "x-test": "1" } });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const { dollar } = setup(["network"], {}, ["127.0.0.1"]);
    expect(await dollar.call("http", "fetch", [`${base}/`])).toMatchObject({
      status: 200,
      body: "ok",
      headers: { "x-test": "1" },
    });
    expect(
      await dollar.call("http", "fetch", [`${base}/chain?to=5`]),
    ).toMatchObject({ body: "landed 5" });
    await expect(
      dollar.call("http", "fetch", [`${base}/chain?to=6`]),
    ).rejects.toThrow("more than 5 redirects");
    await expect(
      dollar.call("http", "fetch", [`${base}/away`]),
    ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.guard });
    await expect(
      dollar.call("http", "fetch", ["https://example.com/"]),
    ).rejects.toThrow("not in network_hosts");
    await expect(dollar.call("http", "fetch", [`${base}/big`])).rejects.toThrow(
      "exceeds",
    );
  } finally {
    server.stop(true);
  }
});

test("network hosts match exactly, by wildcard subdomain, or with a port", () => {
  const url = (value: string) => new URL(value);
  expect(hostMatches(["api.github.com"], url("https://api.github.com/x"))).toBe(
    true,
  );
  expect(hostMatches(["api.github.com"], url("https://github.com/x"))).toBe(
    false,
  );
  expect(hostMatches(["*.github.com"], url("https://api.github.com"))).toBe(
    true,
  );
  expect(hostMatches(["*.github.com"], url("https://github.com"))).toBe(false);
  expect(hostMatches(["*.github.com"], url("https://evilgithub.com"))).toBe(
    false,
  );
  expect(hostMatches(["localhost:8080"], url("http://localhost:8080"))).toBe(
    true,
  );
  expect(hostMatches(["localhost:8080"], url("http://localhost:9090"))).toBe(
    false,
  );
});

test("connection calls are pinned to the event's generation and refuse a replaced runtime", async () => {
  let generation = 4;
  let current = true;
  const calls: Array<[string, unknown]> = [];
  const { dollar, bus } = setup(["workspace.read", "terminal.write"], {
    lease: (id) => ({
      connectionId: id ?? "default",
      generation,
      isCurrent: () => current,
      call: async (method, params) => {
        calls.push([method, params]);
        return { ok: true };
      },
    }),
  });
  const scope = { connection: { id: "laptop", generation: 4 } };
  expect(await dollar.call("roamgate", "workspaces", [], scope)).toEqual({
    ok: true,
  });
  generation = 5;
  await expect(
    dollar.call("roamgate", "workspaces", [], scope),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.connectionChanged });
  current = false;
  await expect(
    dollar.call("terminal", "send", ["p1", "hi"]),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.connectionChanged });
  expect(calls).toEqual([["workspace.list", {}]]);

  current = true;
  const gated: string[] = [];
  bus.add({
    wants: (name) => name === "terminal.submit",
    async dispatch(event) {
      gated.push(String(event.origin));
      return {
        event: { ...event, text: `${event.text}!` },
        gate: { decision: "allow" },
      };
    },
  });
  await dollar.call("terminal", "send", ["p1", "hi"]);
  expect(gated).toEqual(["extension:acme.test"]);
  expect(calls.at(-1)).toEqual([
    "pane.send_text",
    { pane_id: "p1", text: "hi!" },
  ]);
});
