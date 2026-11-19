import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type {
  ExtensionManifest,
  ExtensionRouteContribution,
} from "../../../shared/extensions";

export const PROXY_CAP_TTL_MS = 15 * 60_000;
/** The host page renews its capability this long before it expires. */
export const PROXY_CAP_RENEW_LEAD_MS = 2 * 60_000;
const UPSTREAM_SOCKET_OPEN_TIMEOUT_MS = 10_000;
const MAX_RENEWALS = 10_000;

/** Sandbox CSP of everything served under `/_/<cap>/`: an opaque origin. */
export const PROXY_SANDBOX_CSP =
  "sandbox allow-scripts allow-forms; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'";

/** Request headers that never reach the upstream. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Response headers that never reach the browser. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** A capability and when it lapses; `expires_in` is relative, for browsers. */
export interface ProxyGrant {
  cap: string;
  expires_at: number;
  expires_in: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Capabilities for `/ext/<id>/web/_/<cap>/`: HMAC-SHA256 with the session
 * secret over the extension id, route prefix and expiry, so the opaque-origin
 * frame never holds the session. A logged-in host page can extend a live
 * capability; `revoke` invalidates every capability issued so far.
 */
export class ProxyCaps {
  private readonly renewed = new Map<string, number>();
  private revokedAt = 0;

  constructor(
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  mint(ext: string, prefix: string): ProxyGrant {
    const now = this.now();
    const issuedAt = Math.max(now, this.revokedAt + 1);
    const expiresAt = issuedAt + PROXY_CAP_TTL_MS;
    const exp = expiresAt.toString(36);
    return {
      cap: `${exp}.${this.sign(ext, prefix, exp)}`,
      expires_at: expiresAt,
      expires_in: expiresAt - now,
    };
  }

  /** The capability's expiry when it is authentic and current, else null. */
  expiry(ext: string, prefix: string, cap: string): number | null {
    const match = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(cap);
    if (!match) return null;
    const [, exp = "", signature = ""] = match;
    const expected = Buffer.from(this.sign(ext, prefix, exp));
    const presented = Buffer.from(signature);
    if (
      expected.length !== presented.length ||
      !timingSafeEqual(expected, presented)
    )
      return null;
    const expiresAt = Number.parseInt(exp, 36);
    if (expiresAt - PROXY_CAP_TTL_MS <= this.revokedAt) return null;
    const effective = Math.max(expiresAt, this.renewed.get(cap) ?? 0);
    return effective > this.now() ? effective : null;
  }

  /** Extends a current capability by one TTL from now. */
  renew(ext: string, prefix: string, cap: string): ProxyGrant | null {
    if (this.expiry(ext, prefix, cap) === null) return null;
    const now = this.now();
    for (const [key, until] of this.renewed)
      if (until <= now) this.renewed.delete(key);
    if (this.renewed.size >= MAX_RENEWALS) return null;
    const until = now + PROXY_CAP_TTL_MS;
    this.renewed.set(cap, until);
    return { cap, expires_at: until, expires_in: PROXY_CAP_TTL_MS };
  }

  revoke(): void {
    this.revokedAt = this.now();
    this.renewed.clear();
  }

  private sign(ext: string, prefix: string, exp: string): string {
    return createHmac("sha256", this.secret)
      .update(`${ext}\n${prefix}\n${exp}`)
      .digest("base64url");
  }
}

/** A proxy route's prefix without its trailing slash: `""` for `/`. */
export function routePrefix(route: ExtensionRouteContribution): string {
  return (route.path ?? "/").replace(/\/+$/, "");
}

/** The proxy route serving `sub` (`/` or `/...`): the longest matching prefix. */
export function proxyRouteFor(
  manifest: ExtensionManifest,
  sub: string,
): { route: ExtensionRouteContribution; prefix: string } | null {
  if (!manifest.capabilities.includes("http.routes")) return null;
  let best: { route: ExtensionRouteContribution; prefix: string } | null = null;
  for (const route of manifest.routes) {
    if (route.kind !== "proxy" || !route.upstream) continue;
    const prefix = routePrefix(route);
    if (prefix && sub !== prefix && !sub.startsWith(`${prefix}/`)) continue;
    if (!best || prefix.length > best.prefix.length) best = { route, prefix };
  }
  return best;
}

/** The loopback upstream URL for `rest` (the path after the route prefix). */
export function upstreamUrl(
  route: ExtensionRouteContribution,
  rest: string,
  search: string,
): URL | null {
  let base: URL;
  try {
    base = new URL(route.upstream ?? "");
  } catch {
    return null;
  }
  if (base.protocol !== "http:" || !LOOPBACK_HOSTS.has(base.hostname))
    return null;
  const target = new URL(base.origin);
  target.pathname = `${base.pathname.replace(/\/+$/, "")}${rest}` || "/";
  target.search = search;
  return target;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}

/** Shown in place of a proxy error when nothing listens on the upstream. */
export function notRunningPage(manifest: ExtensionManifest): Response {
  const hint = manifest.start_hint
    ? `<p>Start it with:</p><pre><code>${escapeHtml(manifest.start_hint)}</code></pre>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(manifest.name)} is not running</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:2rem;color:#ddd;background:#16171a}pre{background:#0d0e10;padding:.75rem 1rem;border-radius:6px;overflow:auto}h1{font-size:1.15rem}</style></head>
<body><h1>${escapeHtml(manifest.name)} is not running</h1><p>Roamgate could not reach the server this extension shows here.</p>${hint}<p>Reload this view once it is running.</p></body></html>`;
  return new Response(html, {
    status: 502,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      "cache-control": "no-store",
    },
  });
}

/**
 * The session-authenticated page at `/ext/<id>/web/...`: it embeds the
 * upstream in an opaque-origin frame and renews the frame's capability.
 */
export function proxyHostPage(options: {
  manifest: ExtensionManifest;
  /** The proxied path and query, starting with `/`. */
  path: string;
  grant: ProxyGrant;
}): Response {
  const id = encodeURIComponent(options.manifest.id);
  const nonce = randomBytes(16).toString("base64");
  const src = `/ext/${id}/web/_/${options.grant.cap}${options.path}`;
  const config = JSON.stringify({
    renew: `/api/ext/${id}/web-cap`,
    path: options.path,
    cap: options.grant.cap,
    // Relative, so a browser clock that differs from the server's is fine.
    remaining: options.grant.expires_in,
    lead: PROXY_CAP_RENEW_LEAD_MS,
  }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.manifest.name)}</title>
<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style></head>
<body><iframe id="app" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="${escapeHtml(src)}"></iframe>
<script nonce="${nonce}">
(() => {
  const config = ${config};
  const frame = document.getElementById("app");
  let cap = config.cap;
  const later = (ms) => setTimeout(renew, Math.max(5000, ms));
  async function renew() {
    try {
      const response = await fetch(config.renew, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: config.path, cap }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const next = await response.json();
      if (next.cap !== cap) {
        cap = next.cap;
        frame.src = next.src;
      }
      later(next.expires_in - config.lead);
    } catch {
      later(30000);
    }
  }
  later(config.remaining - config.lead);
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export interface ProxyRequestTarget {
  manifest: ExtensionManifest;
  route: ExtensionRouteContribution;
  prefix: string;
  /** `/ext/<id>/web/_/<cap>`: the public base of this capability. */
  publicBase: string;
  /** The upstream URL of this request. */
  upstream: URL;
}

function forwardedHeaders(req: Request, websocket: boolean): Headers {
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (DROPPED_REQUEST_HEADERS.has(name)) continue;
    if (websocket && name.startsWith("sec-websocket-")) continue;
    headers.append(name, value);
  }
  return headers;
}

/** Maps an upstream `Location` back under the capability's public base. */
function publicLocation(
  location: string,
  target: ProxyRequestTarget,
): string | null {
  let resolved: URL;
  try {
    resolved = new URL(location, target.upstream);
  } catch {
    return null;
  }
  if (resolved.origin !== target.upstream.origin) return location;
  const base = new URL(target.route.upstream ?? "").pathname.replace(
    /\/+$/,
    "",
  );
  if (
    base &&
    resolved.pathname !== base &&
    !resolved.pathname.startsWith(`${base}/`)
  )
    return null;
  const rest = resolved.pathname.slice(base.length);
  return `${target.publicBase}${`${target.prefix}${rest}` || "/"}${resolved.search}${resolved.hash}`;
}

/** Forwards one HTTP request, streaming the response (SSE included). */
export async function proxyHttp(
  req: Request,
  target: ProxyRequestTarget,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(target.upstream, {
      method: req.method,
      headers: forwardedHeaders(req, false),
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.arrayBuffer(),
      redirect: "manual",
      signal: req.signal,
      // Compressed bodies pass through as they are, with their encoding.
      decompress: false,
    });
  } catch (error) {
    if (req.signal.aborted) throw error;
    return notRunningPage(target.manifest);
  }
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (DROPPED_RESPONSE_HEADERS.has(name)) continue;
    if (name === "location") {
      const mapped = publicLocation(value, target);
      if (mapped !== null) headers.set(name, mapped);
      continue;
    }
    headers.append(name, value);
  }
  headers.append("content-security-policy", PROXY_SANDBOX_CSP);
  // The capability is in the URL; it must not leak through Referer.
  headers.set("referrer-policy", "no-referrer");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** State of one bridged WebSocket, kept on the browser socket's data. */
export interface ExtensionProxySocket {
  upstream: WebSocket;
  client: ServerWebSocket<unknown> | null;
  /** Upstream messages that arrived before the browser socket opened. */
  pending: Array<string | ArrayBuffer>;
}

function closeCode(code: number | undefined): number {
  return code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

/**
 * Connects to the upstream WebSocket before the browser upgrade, so the
 * subprotocol it picked can be answered and a refused connection gets the
 * not-running page. Resolves null when the upstream is unreachable.
 */
export function openUpstreamSocket(
  req: Request,
  target: ProxyRequestTarget,
): Promise<ExtensionProxySocket | null> {
  const url = new URL(target.upstream);
  url.protocol = "ws:";
  const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const options: Bun.WebSocketOptions = {
    headers: forwardedHeaders(req, true),
    protocols,
  };
  // The DOM lib's WebSocket type hides Bun's options overload.
  const BunWebSocket = WebSocket as unknown as new (
    url: URL,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  const upstream = new BunWebSocket(url, options);
  upstream.binaryType = "arraybuffer";
  const state: ExtensionProxySocket = { upstream, client: null, pending: [] };
  const { promise, resolve } =
    Promise.withResolvers<ExtensionProxySocket | null>();
  const timer = setTimeout(() => {
    upstream.close();
    resolve(null);
  }, UPSTREAM_SOCKET_OPEN_TIMEOUT_MS);
  upstream.addEventListener("open", () => {
    clearTimeout(timer);
    resolve(state);
  });
  upstream.addEventListener("error", () => {
    clearTimeout(timer);
    resolve(null);
  });
  upstream.addEventListener("message", (event) => {
    const data = event.data as string | ArrayBuffer;
    if (state.client) state.client.send(data);
    else state.pending.push(data);
  });
  upstream.addEventListener("close", (event) => {
    clearTimeout(timer);
    resolve(null);
    state.client?.close(closeCode(event.code), event.reason);
  });
  return promise;
}

/** Browser-side handlers of a bridged socket; index.ts routes them here. */
export const proxySocketHandlers = {
  open(ws: ServerWebSocket<unknown>, state: ExtensionProxySocket): void {
    if (state.upstream.readyState !== WebSocket.OPEN) {
      ws.close(1011, "upstream closed");
      return;
    }
    state.client = ws;
    for (const data of state.pending.splice(0)) ws.send(data);
  },
  message(state: ExtensionProxySocket, message: string | Buffer): void {
    if (state.upstream.readyState === WebSocket.OPEN)
      // Bun's server buffers are plain ArrayBuffer views.
      state.upstream.send(message as string | Uint8Array<ArrayBuffer>);
  },
  close(state: ExtensionProxySocket, code?: number, reason?: string): void {
    state.client = null;
    if (
      state.upstream.readyState === WebSocket.OPEN ||
      state.upstream.readyState === WebSocket.CONNECTING
    )
      state.upstream.close(closeCode(code), reason?.slice(0, 120));
  },
};
