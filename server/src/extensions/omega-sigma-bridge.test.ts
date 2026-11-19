import { afterEach, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROXY_CAP_TTL_MS, ProxyCaps } from "./proxy";
import { serveExtensionRoutes } from "./route-fixtures";
import { createExtensionRoutes } from "./routes";
import { createExtensionSandbox } from "./test-fixtures";
import { WebhookTokens } from "./webhooks";

const ID = "roamgate.omega-sigma-bridge";
const example = join(
  import.meta.dir,
  "../../../examples/extensions/omega-sigma-bridge",
);
const sandbox = createExtensionSandbox();
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await sandbox.cleanup();
});

/** Stands in for the OmegaSigma server: JSON, SSE, a redirect and a socket. */
function startUpstream() {
  const seen: Array<Record<string, string | null>> = [];
  const second = Promise.withResolvers<void>();
  const upstream = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/socket") {
        const offered = req.headers.get("sec-websocket-protocol") ?? "";
        return server.upgrade(req, {
          headers: offered.includes("omega.v1")
            ? { "sec-websocket-protocol": "omega.v1" }
            : {},
        })
          ? undefined
          : new Response("no upgrade", { status: 400 });
      }
      if (url.pathname === "/events") {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("data: one\n\n"));
            await second.promise;
            controller.enqueue(encoder.encode("data: two\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/moved")
        return new Response(null, {
          status: 302,
          headers: { location: "/api/echo?from=moved" },
        });
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        cookie: req.headers.get("cookie"),
        authorization: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.text() : null,
      });
      return Response.json(seen.at(-1), {
        headers: { "set-cookie": "upstream=1; Path=/" },
      });
    },
    websocket: {
      message(ws, message) {
        ws.send(typeof message === "string" ? `echo:${message}` : message);
      },
    },
  });
  cleanups.push(() => upstream.stop(true));
  return { upstream, seen, releaseSecond: () => second.resolve() };
}

function setup(port: number) {
  const dir = join(sandbox.root, "src", "omega-sigma-bridge");
  cpSync(example, dir, { recursive: true });
  const manifest = join(dir, "roamgate-extension.toml");
  // The test's upstream listens on an ephemeral port; the hint checks escaping.
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8")
      .replace("http://127.0.0.1:4747", `http://127.0.0.1:${port}`)
      .replace(
        'start_hint = "omega-sigma serve --port 4747"',
        'start_hint = "omega-sigma serve --port 4747 && echo <b>up</b>"',
      ),
  );
  const registry = sandbox.registry();
  registry.add({
    id: ID,
    source: { kind: "link", location: dir },
    version: "1.0.0",
    path: dir,
    enabled: true,
  });
  const { host } = sandbox.host(registry);
  host.start();
  let now = Date.now();
  const caps = new ProxyCaps("d".repeat(64), () => now);
  const routes = createExtensionRoutes({
    registry,
    host,
    tokens: new WebhookTokens(sandbox.paths),
    caps,
  });
  const listener = serveExtensionRoutes(routes);
  cleanups.push(listener.stop);
  return {
    registry,
    host,
    caps,
    routes,
    advance: (ms: number) => {
      now += ms;
    },
    ...listener,
  };
}

async function capBase(base: string, cookie: string): Promise<string> {
  const page = await fetch(`${base}/ext/${ID}/web/`, { headers: { cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  const src =
    /<iframe id="app" sandbox="allow-scripts allow-forms" [^>]*src="([^"]+)"/.exec(
      html,
    )?.[1];
  if (!src) throw new Error("host page has no frame");
  return src.replace(/\/$/, "");
}

test("AC-01-29: the example declares an OMP agent action whose command opens the proxied viewer", async () => {
  const { registry, host } = setup(4747);
  const record = registry.get(ID);
  if (!record) throw new Error("not registered");
  const { manifest, errors } = registry.validate(record);
  expect(errors).toEqual([]);
  expect(manifest?.slots).toEqual([
    {
      slot: "context-menu.agent",
      id: "omega",
      title: "OmegaSigma",
      command: "open",
      when: { agent: "omp" },
    },
  ]);
  expect(manifest?.routes).toEqual([
    {
      kind: "proxy",
      upstream: "http://127.0.0.1:4747",
      path: "/",
      name: undefined,
      timeout: undefined,
    },
  ]);
  expect(
    await host.runCommand(ID, "open", {
      agent: "omp",
      checkout_path: "/work/repo",
    }),
  ).toEqual({
    open: `/ext/${ID}/web/?cwd=%2Fwork%2Frepo&session=latest`,
  });
});

test("AC-01-28: logged in, HTTP reaches the loopback upstream without Roamgate credentials", async () => {
  const { upstream, seen } = startUpstream();
  const { base, login } = setup(upstream.port as number);
  expect((await fetch(`${base}/ext/${ID}/web/`)).status).toBe(401);
  const cookie = await login();
  const proxied = await capBase(base, cookie);
  expect(proxied).toMatch(
    new RegExp(`^/ext/${ID.replace(/\./g, "\\.")}/web/_/`),
  );
  const response = await fetch(`${base}${proxied}/api/echo?x=1`, {
    headers: { cookie, authorization: "Bearer roamgate" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    method: "GET",
    path: "/api/echo?x=1",
    cookie: null,
    authorization: null,
    body: null,
  });
  // Opaque origin, no cookies set on Roamgate's host, no capability in Referer.
  expect(response.headers.get("content-security-policy")).toStartWith(
    "sandbox allow-scripts allow-forms;",
  );
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const posted = await fetch(`${base}${proxied}/api/echo`, {
    method: "POST",
    body: "hello",
  });
  expect(await posted.json()).toMatchObject({ body: "hello" });
  const moved = await fetch(`${base}${proxied}/moved`, { redirect: "manual" });
  expect(moved.status).toBe(302);
  expect(moved.headers.get("location")).toBe(`${proxied}/api/echo?from=moved`);
  expect(seen).toHaveLength(2);
});

test("AC-01-28: server-sent events stream through as they are sent", async () => {
  const { upstream, releaseSecond } = startUpstream();
  const { base, login } = setup(upstream.port as number);
  const proxied = await capBase(base, await login());
  const response = await fetch(`${base}${proxied}/events`);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const decoder = new TextDecoder();
  // The first event arrives while the upstream still holds the second.
  const first = await reader.read();
  expect(decoder.decode(first.value)).toBe("data: one\n\n");
  releaseSecond();
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += decoder.decode(chunk.value);
  }
  expect(rest).toBe("data: two\n\n");
});

test("AC-01-28: WebSocket messages and the subprotocol pass through the capability route", async () => {
  const { upstream } = startUpstream();
  const { base, login } = setup(upstream.port as number);
  const proxied = await capBase(base, await login());
  const socket = new WebSocket(
    `${base.replace("http:", "ws:")}${proxied}/socket`,
    ["omega.v1"],
  );
  cleanups.push(() => socket.close());
  socket.binaryType = "arraybuffer";
  const messages: unknown[] = [];
  const received = Promise.withResolvers<void>();
  socket.addEventListener("message", (event) => {
    messages.push(
      typeof event.data === "string"
        ? event.data
        : [...new Uint8Array(event.data as ArrayBuffer)],
    );
    if (messages.length === 2) received.resolve();
  });
  const opened = Promise.withResolvers<void>();
  socket.addEventListener("open", () => opened.resolve());
  socket.addEventListener("error", () => opened.reject(new Error("no socket")));
  await opened.promise;
  expect(socket.protocol).toBe("omega.v1");
  socket.send("ping");
  socket.send(new Uint8Array([1, 2, 3]));
  await received.promise;
  expect(messages).toEqual(["echo:ping", [1, 2, 3]]);
});

test("capabilities: tampered, expired, revoked or for another route are refused with 403", async () => {
  const { upstream } = startUpstream();
  const { base, login, caps, advance, routes } = setup(upstream.port as number);
  const proxied = await capBase(base, await login());
  const cap = proxied.split("/")[5] ?? "";
  const tampered = cap.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
  const at = (value: string) =>
    fetch(`${base}/ext/${ID}/web/_/${value}/api/echo`);
  expect((await at(cap)).status).toBe(200);
  expect((await at(tampered)).status).toBe(403);
  expect((await at("garbage")).status).toBe(403);
  const otherRoute = caps.mint(ID, "/api").cap;
  expect((await at(otherRoute)).status).toBe(403);
  advance(PROXY_CAP_TTL_MS + 1);
  expect((await at(cap)).status).toBe(403);
  const fresh = caps.mint(ID, "").cap;
  expect((await at(fresh)).status).toBe(200);
  routes.revokeCaps();
  expect((await at(fresh)).status).toBe(403);
});

test("capabilities: the logged-in host page renews a capability before it lapses", async () => {
  const { upstream } = startUpstream();
  const { base, login, advance } = setup(upstream.port as number);
  const cookie = await login();
  const proxied = await capBase(base, cookie);
  const cap = proxied.split("/")[5] ?? "";
  advance(PROXY_CAP_TTL_MS - 60_000);
  const renewal = await fetch(`${base}/api/ext/${ID}/web-cap`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ path: "/", cap }),
  });
  expect(await renewal.json()).toMatchObject({ cap });
  advance(PROXY_CAP_TTL_MS - 60_000);
  expect((await fetch(`${base}${proxied}/api/echo`)).status).toBe(200);
});

test("AC-01-28: a stopped upstream shows the not-running page with the escaped start hint", async () => {
  const { upstream } = startUpstream();
  const { base, login } = setup(upstream.port as number);
  const proxied = await capBase(base, await login());
  upstream.stop(true);
  for (const path of ["/", "/socket"]) {
    const response = await fetch(`${base}${proxied}${path}`, {
      headers:
        path === "/socket"
          ? {
              upgrade: "websocket",
              connection: "Upgrade",
              "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
              "sec-websocket-version": "13",
            }
          : {},
    });
    expect(response.status).toBe(502);
    const html = await response.text();
    expect(html).toContain("OmegaSigma is not running");
    expect(html).toContain(
      "omega-sigma serve --port 4747 &amp;&amp; echo &lt;b&gt;up&lt;/b&gt;",
    );
    expect(html).not.toContain("<b>up</b>");
    expect(response.headers.get("content-security-policy")).toStartWith(
      "sandbox;",
    );
  }
});
