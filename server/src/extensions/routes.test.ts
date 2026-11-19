import { afterEach, expect, test } from "bun:test";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingApproval } from "../../../shared/extensions";
import { ApprovalService, installApprovals } from "./approvals";
import { frameCsp } from "./frames";
import { ProxyCaps } from "./proxy";
import { serveExtensionRoutes } from "./route-fixtures";
import { createExtensionRoutes } from "./routes";
import { createExtensionRpc } from "./rpc";
import { createExtensionSandbox } from "./test-fixtures";
import { WebhookTokens } from "./webhooks";

const sandbox = createExtensionSandbox();
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await sandbox.cleanup();
});

const MOD = `
export function register(on) {
  on("webhook", { route: "permission" }, async ($, event) => {
    const answer = await $.ui.ask({ title: "Run " + event.body.command + "?" });
    return { decision: answer.approved ? "allow" : "deny", query: event.query };
  });
  on("webhook", { route: "slow" }, async ($) => {
    await $.ui.ask({ title: "nobody answers", timeout_ms: 60000 });
    return { late: true };
  });
  on("frame.call", { frame: "chart", method: "double" }, (_$, event) => ({
    value: event.params.n * 2,
  }));
  on("command.run", { command: "tick" }, async ($) => {
    await $.events.emit("tick", { n: 1 }, { frame: "chart" });
    return null;
  });
}
`;

const MANIFEST = `
capabilities = ["ui", "gates", "commands", "http.routes"]
[[commands]]
id = "tick"
title = "Tick"
[[routes]]
kind = "webhook"
name = "permission"
[[routes]]
kind = "webhook"
name = "slow"
timeout = 1
[[routes]]
kind = "proxy"
upstream = "http://127.0.0.1:9"
path = "/"
[[frames]]
id = "chart"
entry = "./frames/chart.html"
csp = { connect = ["https://api.example.com"], resource = ["https://cdn.example.com"] }
`;

function setup() {
  const registry = sandbox.registry();
  const dir = sandbox.link("acme.routes", MOD, MANIFEST, registry);
  mkdirSync(join(dir, "frames"));
  writeFileSync(join(dir, "frames", "chart.html"), "<p>chart</p>");
  writeFileSync(join(dir, "frames", "chart.js"), "console.log(1)");
  // A link out of the frame directory must not serve the mod source.
  symlinkSync(join(dir, "mod.ts"), join(dir, "frames", "escape.ts"));
  const frameEvents: unknown[] = [];
  const { host } = sandbox.host(registry, {
    dollar: { frameEvent: (ext, event) => frameEvents.push({ ext, ...event }) },
  });
  host.start();
  const tokens = new WebhookTokens(sandbox.paths);
  const routes = createExtensionRoutes({
    registry,
    host,
    tokens,
    caps: new ProxyCaps("c".repeat(64)),
  });
  const rpc = createExtensionRpc({
    registry,
    host,
    installer: undefined as never,
    previews: undefined as never,
    broadcast: () => undefined,
    webhookTokens: tokens,
  });
  const listener = serveExtensionRoutes(routes);
  cleanups.push(listener.stop);
  return { registry, host, tokens, rpc, frameEvents, ...listener };
}

function approve(answer: (pending: PendingApproval) => boolean | null) {
  const asked: string[] = [];
  const approvals = new ApprovalService({
    announce: (pending) => {
      asked.push(pending.title);
      const decision = answer(pending);
      if (decision !== null)
        approvals.answer(pending.id, decision ? "approve" : "deny", "test");
    },
  });
  const off = installApprovals(approvals);
  cleanups.push(() => {
    off();
    approvals.dispose();
  });
  return asked;
}

async function webhookToken(rpc: ReturnType<typeof setup>["rpc"]) {
  return (await rpc.handle("ext.manage", {
    op: "webhook_token",
    id: "acme.routes",
  })) as { token: string; url_base: string };
}

test("AC-01-27: a webhook without the bearer token gets 401 and never reaches the mod", async () => {
  const { base, host, rpc } = setup();
  await webhookToken(rpc);
  for (const authorization of [undefined, "Bearer wrong", "Basic abc"]) {
    const response = await fetch(
      `${base}/api/ext/acme.routes/hooks/permission`,
      {
        method: "POST",
        headers: authorization ? { authorization } : {},
        body: JSON.stringify({ command: "rm -rf build" }),
      },
    );
    expect(response.status).toBe(401);
  }
  expect(host.isRunning("acme.routes")).toBe(false);
});

test("AC-01-27: with the token, the response waits for the person's decision; no session cookie is needed", async () => {
  const { base, rpc } = setup();
  const asked = approve((pending) => pending.title !== "Run rm -rf build?");
  const { token, url_base } = await webhookToken(rpc);
  expect(url_base).toBe("/api/ext/acme.routes/hooks/");
  const post = (command: string) =>
    fetch(`${base}${url_base}permission?pane=p1`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ command }),
    });
  const denied = await post("rm -rf build");
  expect(denied.status).toBe(200);
  expect(await denied.json()).toEqual({
    decision: "deny",
    query: { pane: "p1" },
  });
  const allowed = await post("ls");
  expect(await allowed.json()).toEqual({
    decision: "allow",
    query: { pane: "p1" },
  });
  expect(asked).toEqual(["Run rm -rf build?", "Run ls?"]);
});

test("webhook errors: unknown extension or route 404, oversized 413, bad JSON 400, unanswered 504", async () => {
  const { base, rpc } = setup();
  approve(() => null);
  const { token } = await webhookToken(rpc);
  const post = (path: string, body: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });
  expect(
    (await post("/api/ext/acme.nobody/hooks/permission", "{}")).status,
  ).toBe(404);
  expect((await post("/api/ext/acme.routes/hooks/other", "{}")).status).toBe(
    404,
  );
  const big = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
  expect(
    (await post("/api/ext/acme.routes/hooks/permission", big)).status,
  ).toBe(413);
  expect(
    (await post("/api/ext/acme.routes/hooks/permission", "{nope")).status,
  ).toBe(400);
  const started = Date.now();
  const slow = await post("/api/ext/acme.routes/hooks/slow", "{}");
  expect(slow.status).toBe(504);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(
    (
      await fetch(`${base}/api/ext/acme.routes/hooks/permission`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(405);
});

test("webhook tokens are private files, shown once made and replaced on rotation", async () => {
  const { tokens, rpc, base } = setup();
  expect(tokens.read("acme.routes")).toBeNull();
  const first = await webhookToken(rpc);
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await webhookToken(rpc)).token).toBe(first.token);
  const file = join(sandbox.paths.dataDir("acme.routes"), "webhook-token");
  if (process.platform !== "win32")
    expect(statSync(file).mode & 0o777).toBe(0o600);
  const rotated = (await rpc.handle("ext.manage", {
    op: "webhook_token",
    id: "acme.routes",
    rotate: true,
  })) as { token: string };
  expect(rotated.token).not.toBe(first.token);
  expect(tokens.matches("acme.routes", first.token)).toBe(false);
  expect(tokens.matches("acme.routes", rotated.token)).toBe(true);
  const stale = await fetch(`${base}/api/ext/acme.routes/hooks/permission`, {
    method: "POST",
    headers: { authorization: `Bearer ${first.token}` },
    body: "{}",
  });
  expect(stale.status).toBe(401);
});

test("frame assets need the session and carry the sandbox CSP with declared domains only", async () => {
  const { base, login } = setup();
  const url = `${base}/ext/acme.routes/frame/frames/chart.html`;
  expect((await fetch(url)).status).toBe(401);
  const cookie = await login();
  const response = await fetch(url, { headers: { cookie } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("<p>chart</p>");
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toStartWith(
    "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.example.com; style-src 'self' 'unsafe-inline' https://cdn.example.com; img-src 'self' data: https://cdn.example.com",
  );
  expect(csp).toContain("connect-src https://api.example.com");
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).not.toContain("frame-src");
  const script = await fetch(`${base}/ext/acme.routes/frame/frames/chart.js`, {
    headers: { cookie },
  });
  expect(script.status).toBe(200);
  for (const path of [
    "mod.ts",
    "roamgate-extension.toml",
    "frames/escape.ts",
    "frames/missing.html",
    "frames/..%2fmod.ts",
  ]) {
    const denied = await fetch(`${base}/ext/acme.routes/frame/${path}`, {
      headers: { cookie },
    });
    expect([path, denied.status]).toEqual([path, 404]);
  }
});

test("frame CSP ignores sources that could inject directives", () => {
  expect(
    frameCsp({ connect: ["https://ok.example", "x; script-src *"] }),
  ).toContain("connect-src https://ok.example;");
  expect(frameCsp()).not.toContain("connect-src");
});

test("ext.frame.call runs the mod's frame handler and $.events.emit reaches the frame push", async () => {
  const { rpc, host, frameEvents } = setup();
  expect(
    await rpc.handle("ext.frame.call", {
      ext: "acme.routes",
      frame: "chart",
      method: "double",
      params: { n: 21 },
    }),
  ).toEqual({ result: { value: 42 } });
  await expect(
    rpc.handle("ext.frame.call", {
      ext: "acme.routes",
      frame: "other",
      method: "double",
    }),
  ).rejects.toThrow('acme.routes has no frame "other"');
  await host.runCommand("acme.routes", "tick");
  expect(frameEvents).toEqual([
    { ext: "acme.routes", frame: "chart", name: "tick", data: { n: 1 } },
  ]);
});

test("the web host page needs the session; its capability route does not", async () => {
  const { base, login } = setup();
  const page = await fetch(`${base}/ext/acme.routes/web/?q=1`, {
    redirect: "manual",
  });
  expect(page.status).toBe(401);
  const cookie = await login();
  const redirect = await fetch(`${base}/ext/acme.routes/web?q=1`, {
    headers: { cookie },
    redirect: "manual",
  });
  expect(redirect.headers.get("location")).toBe("/ext/acme.routes/web/?q=1");
  const host = await fetch(`${base}/ext/acme.routes/web/?q=1`, {
    headers: { cookie },
  });
  const html = await host.text();
  const src =
    /<iframe[^>]*sandbox="allow-scripts allow-forms"[^>]*src="([^"]+)"/.exec(
      html,
    )?.[1];
  expect(src).toMatch(
    /^\/ext\/acme\.routes\/web\/_\/[0-9a-z]+\.[\w-]{43}\/\?q=1$/,
  );
  expect(host.headers.get("content-security-policy")).toContain(
    "script-src 'nonce-",
  );
  // No cookie: the capability is the authority. Port 9 has no server.
  const proxied = await fetch(`${base}${src}`);
  expect(proxied.status).toBe(502);
  expect(await proxied.text()).toContain("acme.routes is not running");
  const cap = src?.split("/")[5] ?? "";
  const renewed = await fetch(`${base}/api/ext/acme.routes/web-cap`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ path: "/?q=1", cap }),
  });
  const grant = (await renewed.json()) as { cap: string; src: string };
  expect(grant.cap).toBe(cap);
  expect(grant.src).toBe(src as string);
  const unauthenticatedRenewal = await fetch(
    `${base}/api/ext/acme.routes/web-cap`,
    { method: "POST", body: JSON.stringify({ path: "/" }) },
  );
  expect(unauthenticatedRenewal.status).toBe(401);
});
