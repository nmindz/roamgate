import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { gateRpcAction } from "./action-events";
import { ApprovalService, installApprovals } from "./approvals";
import {
  HOOK_OUTPUT_MAX_BYTES,
  runUrlHook,
  type UrlHook,
} from "./command-hooks";
import { hookUrlError, validateManifest } from "./manifest";
import type { ExtensionRegistry } from "./registry";
import { createExtensionSandbox } from "./test-fixtures";

const sandbox = createExtensionSandbox();
const servers: Server<undefined>[] = [];
afterEach(() => {
  sandbox.cleanup();
  for (const server of servers.splice(0)) server.stop(true);
});

const connection = { id: "c1", generation: 1 };

/** A loopback endpoint on an ephemeral port; records what each request carried. */
type Handler = (
  body: Record<string, unknown> | null,
) => Response | Promise<Response>;

function serve(handler: Handler) {
  const requests: Array<{
    method: string;
    path: string;
    type: string | null;
    cookie: string | null;
    authorization: string | null;
    body: unknown;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const text = await request.text();
      const body: Record<string, unknown> | null = text
        ? JSON.parse(text)
        : null;
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        type: request.headers.get("content-type"),
        cookie: request.headers.get("cookie"),
        authorization: request.headers.get("authorization"),
        body,
      });
      return handler(body);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

const json = (value: unknown) => Response.json(value);

function linkUrlHook(
  registry: ExtensionRegistry,
  id: string,
  hook: { url: string; on?: string; timeout?: number; on_failure?: string },
  manifest = "",
) {
  sandbox.link(
    id,
    null,
    `${manifest}
[[hooks]]
on = ${JSON.stringify(hook.on ?? "pane.close")}
url = ${JSON.stringify(hook.url)}
${hook.timeout === undefined ? "" : `timeout = ${hook.timeout}`}
${hook.on_failure === undefined ? "" : `on_failure = ${JSON.stringify(hook.on_failure)}`}
`,
    registry,
  );
}

function start(registry: ExtensionRegistry) {
  const { host, bus } = sandbox.host(registry);
  host.start();
  return { host, bus };
}

function withApprovals(answer: "approve" | "deny") {
  const asked: string[] = [];
  const approvals = new ApprovalService({
    announce: (pending) => {
      asked.push(pending.title);
      approvals.answer(pending.id, answer, "test");
    },
  });
  const off = installApprovals(approvals);
  return {
    asked,
    dispose: () => {
      off();
      approvals.dispose();
    },
  };
}

test("a url hook POSTs the event JSON and its allow lets the action through", async () => {
  const endpoint = serve(() => json({ decision: "allow" }));
  const registry = sandbox.registry();
  linkUrlHook(registry, "allow-url", { url: `${endpoint.url}/hook` });
  const { bus, host } = start(registry);
  expect(bus.wants("pane.close")).toBe(true);
  const params = { pane_id: "p1" };
  expect(await gateRpcAction(connection, "pane.close", params, { bus })).toBe(
    params,
  );
  expect(endpoint.requests).toHaveLength(1);
  const [request] = endpoint.requests;
  expect(request?.method).toBe("POST");
  expect(request?.path).toBe("/hook");
  expect(request?.type).toBe("application/json");
  expect(request?.cookie).toBeNull();
  expect(request?.authorization).toBeNull();
  expect(request?.body).toMatchObject({ name: "pane.close", pane_id: "p1" });
  // Url hooks need no mod.
  expect(host.isRunning("allow-url")).toBe(false);
});

test("a url hook deny blocks the action with its reason", async () => {
  const endpoint = serve(() =>
    json({ decision: "deny", reason: "pane p1 is protected" }),
  );
  const registry = sandbox.registry();
  linkUrlHook(registry, "deny-url", { url: endpoint.url });
  const { bus } = start(registry);
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
  ).rejects.toThrow("Denied by extension deny-url: pane p1 is protected");
  expect(registry.get("deny-url")?.failures).toEqual([]);
});

test("a url hook ask runs the approval flow, using the reason as title", async () => {
  const endpoint = serve(() =>
    json({ decision: "ask", reason: "Close the deploy pane?" }),
  );
  const registry = sandbox.registry();
  linkUrlHook(registry, "ask-url", { url: endpoint.url });
  const { bus } = start(registry);
  const approve = withApprovals("approve");
  try {
    const params = { pane_id: "p1" };
    expect(
      await gateRpcAction(connection, "pane.close", params, { bus }),
    ).toEqual(params);
    expect(approve.asked).toEqual(["Close the deploy pane?"]);
  } finally {
    approve.dispose();
  }
  const deny = withApprovals("deny");
  try {
    await expect(
      gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
    ).rejects.toThrow();
  } finally {
    deny.dispose();
  }
});

test("an empty 2xx answer is no opinion", async () => {
  const endpoint = serve(() => new Response(null, { status: 204 }));
  const registry = sandbox.registry();
  linkUrlHook(registry, "quiet-url", {
    url: endpoint.url,
    on_failure: "block",
  });
  const { bus } = start(registry);
  const params = { pane_id: "p1" };
  expect(await gateRpcAction(connection, "pane.close", params, { bus })).toBe(
    params,
  );
  expect(registry.get("quiet-url")?.failures).toEqual([]);
});

test("a url hook rewrite follows the host's rewrite rules", async () => {
  const endpoint = serve((body) =>
    json({
      rewrite: {
        text: `${body?.text}!`,
        pane_id: "elsewhere",
      },
      message: "added emphasis",
    }),
  );
  const registry = sandbox.registry();
  linkUrlHook(registry, "rewrite-url", {
    url: endpoint.url,
    on: "terminal.submit",
  });
  const { bus, host } = start(registry);
  const outcome = await bus.gate({
    name: "terminal.submit",
    pane_id: "p1",
    text: "hi",
  });
  expect(outcome.gate.decision).toBe("allow");
  expect(outcome.event.text).toBe("hi!");
  expect(outcome.event.pane_id).toBe("p1");
  const lines = host.logs("rewrite-url").map((entry) => entry.line);
  expect(lines.some((line) => line.includes("added emphasis"))).toBe(true);
});

test("a url hook past its timeout under block denies", async () => {
  // Never answers; the hook's own 1 s timeout is what this exercises.
  const endpoint = serve(() => new Promise<Response>(() => undefined));
  const registry = sandbox.registry();
  linkUrlHook(registry, "slow-url", {
    url: endpoint.url,
    timeout: 1,
    on_failure: "block",
  });
  const { bus } = start(registry);
  const started = Date.now();
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
  ).rejects.toThrow("Denied by extension slow-url: extension error");
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(registry.get("slow-url")?.failures[0]?.error).toContain(
    "timed out after 1000ms",
  );
}, 10_000);

test("a non-2xx answer under continue is a failure that lets the action through", async () => {
  const endpoint = serve(
    () => new Response(JSON.stringify({ decision: "deny" }), { status: 500 }),
  );
  const registry = sandbox.registry();
  linkUrlHook(registry, "broken-url", { url: endpoint.url });
  const { bus } = start(registry);
  const params = { pane_id: "p1" };
  expect(await gateRpcAction(connection, "pane.close", params, { bus })).toBe(
    params,
  );
  const failures = registry.get("broken-url")?.failures ?? [];
  expect(failures).toHaveLength(1);
  expect(failures[0]?.error).toContain("answered HTTP 500");
});

test("invalid JSON is a failure handled by on_failure", async () => {
  const endpoint = serve(() => new Response("not json"));
  const registry = sandbox.registry();
  linkUrlHook(registry, "garbled-url", {
    url: endpoint.url,
    on_failure: "block",
  });
  const { bus } = start(registry);
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
  ).rejects.toThrow("extension error");
  expect(registry.get("garbled-url")?.failures[0]?.error).toContain(
    "invalid JSON",
  );
});

test("an answer over 1 MiB is a failure", async () => {
  const endpoint = serve(
    () =>
      new Response(`{"message":"${"x".repeat(HOOK_OUTPUT_MAX_BYTES)}"}`, {
        headers: { "content-type": "application/json" },
      }),
  );
  const registry = sandbox.registry();
  linkUrlHook(registry, "big-url", { url: endpoint.url, on_failure: "block" });
  const { bus } = start(registry);
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
  ).rejects.toThrow("extension error");
  expect(registry.get("big-url")?.failures[0]?.error).toContain(
    `exceeded ${HOOK_OUTPUT_MAX_BYTES} bytes`,
  );
});

test("redirects are not followed and count as a failure", async () => {
  const target = serve(() => json({ decision: "allow" }));
  const endpoint = serve(
    () =>
      new Response(null, {
        status: 307,
        headers: { location: `${target.url}/elsewhere` },
      }),
  );
  const result = await runUrlHook(
    {
      ext: "redirect-url",
      root: sandbox.root,
      paths: sandbox.paths,
      hook: { on: "pane.close", url: endpoint.url },
    },
    { name: "pane.close", at: Date.now(), pane_id: "p1" },
  );
  expect(result).toEqual({
    ok: false,
    error: `url hook ${endpoint.url} answered HTTP 307`,
  });
  expect(endpoint.requests).toHaveLength(1);
  expect(target.requests).toHaveLength(0);
});

test("a host outside loopback and network_hosts is refused at request time", async () => {
  const hook: UrlHook = { on: "pane.close", url: "http://example.com/hook" };
  const refused = await runUrlHook(
    { ext: "far", root: sandbox.root, paths: sandbox.paths, hook },
    { name: "pane.close", at: Date.now(), pane_id: "p1" },
  );
  expect(refused).toEqual({
    ok: false,
    error:
      "url hook http://example.com/hook: example.com is neither loopback nor in network_hosts",
  });
  // A network_hosts entry is allowed; the port must match when given.
  expect(hookUrlError("https://hooks.example.com/x", ["*.example.com"])).toBe(
    null,
  );
  expect(hookUrlError("http://example.com:81/x", ["example.com:80"])).toContain(
    "neither loopback",
  );
  for (const url of [
    "http://localhost:9/x",
    "http://[::1]:9/x",
    "http://127.0.0.1/x",
  ])
    expect(hookUrlError(url, [])).toBe(null);
  expect(hookUrlError("ftp://127.0.0.1/x", [])).toBe("expected an http(s) URL");
  expect(hookUrlError("http://user:pw@127.0.0.1/x", [])).toBe(
    "must not carry credentials",
  );
});

test("manifest validation rejects url hooks to hosts that are not allowed", () => {
  const base = {
    id: "v",
    name: "v",
    version: "1.0.0",
    api: "^1.0",
  };
  const validate = (extra: Record<string, unknown>) =>
    validateManifest({ ...base, ...extra }, sandbox.root, {
      appVersion: "0.8.15",
      platform: "linux",
    }).errors;
  expect(
    validate({ hooks: [{ on: "pane.close", url: "http://example.com/h" }] }),
  ).toEqual([
    "hooks[0].url: example.com is neither loopback nor in network_hosts",
  ]);
  expect(
    validate({
      network_hosts: ["example.com"],
      hooks: [{ on: "pane.close", url: "https://example.com/h" }],
    }),
  ).toEqual([]);
  expect(
    validate({
      hooks: [
        { on: "pane.close", url: "http://127.0.0.1/h", command: ["true"] },
      ],
    }),
  ).toEqual(["hooks[0]: set exactly one of command or url"]);
});

test("a disallowed url hook in a registered manifest never runs", async () => {
  const endpoint = serve(() => json({ decision: "deny" }));
  const registry = sandbox.registry();
  // localhost is allowed; the same server through a non-loopback name is not.
  linkUrlHook(registry, "bad-url", {
    url: endpoint.url.replace("127.0.0.1", "roamgate.invalid"),
  });
  const { bus } = start(registry);
  expect(bus.wants("pane.close")).toBe(false);
  expect(endpoint.requests).toHaveLength(0);
});
