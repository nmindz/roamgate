import { createAuthHandlers } from "../http/auth";
import { type ExtensionProxySocket, proxySocketHandlers } from "./proxy";
import type { ExtensionRoutes } from "./routes";

const PASSWORD = "extension-route-test-password";

/**
 * A listener with index.ts's order: public extension routes, the session
 * check, then authenticated extension routes. `login()` returns a cookie.
 */
export function serveExtensionRoutes(routes: ExtensionRoutes) {
  const auth = createAuthHandlers({
    sessionSecret: "b".repeat(64),
    password: PASSWORD,
  });
  const server = Bun.serve<{ extProxy?: ExtensionProxySocket }>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      const handled = await routes.handlePublic(req, url, {
        upgrade: (request, extProxy, headers) =>
          server.upgrade(request, { headers, data: { extProxy } }),
        timeout: (request, seconds) => server.timeout(request, seconds),
      });
      if (handled === "upgraded") return undefined;
      if (handled) return handled;
      if (!auth.isAuthed(req))
        return new Response("unauthorized", { status: 401 });
      return (
        (await routes.handleAuthed(req, url)) ??
        new Response("app shell", { status: 200 })
      );
    },
    websocket: {
      open(ws) {
        if (ws.data.extProxy) proxySocketHandlers.open(ws, ws.data.extProxy);
      },
      message(ws, message) {
        if (ws.data.extProxy)
          proxySocketHandlers.message(ws.data.extProxy, message);
      },
      close(ws, code, reason) {
        if (ws.data.extProxy)
          proxySocketHandlers.close(ws.data.extProxy, code, reason);
      },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  async function login(): Promise<string> {
    const response = await auth.handleLogin(
      new Request(`${base}/api/login`, {
        method: "POST",
        body: JSON.stringify({ password: PASSWORD }),
      }),
      "127.0.0.1",
    );
    const cookie = response.headers.get("set-cookie");
    if (!cookie) throw new Error("login failed");
    return cookie.split(";", 1)[0] ?? "";
  }

  return { server, base, login, stop: () => server.stop(true) };
}
