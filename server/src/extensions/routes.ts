import {
  EXTENSION_ID_PATTERN,
  type ExtensionManifest,
} from "../../../shared/extensions";
import { readJsonBody } from "../http/json-body";
import { serveFrameAsset } from "./frames";
import type { ExtensionHost } from "./host";
import {
  type ExtensionProxySocket,
  notRunningPage,
  openUpstreamSocket,
  type ProxyCaps,
  type ProxyRequestTarget,
  proxyHostPage,
  proxyHttp,
  proxyRouteFor,
  upstreamUrl,
} from "./proxy";
import type { ExtensionRegistry } from "./registry";
import { handleWebhook, type WebhookTokens } from "./webhooks";

/** The slice of Bun's server the extension routes use. */
export interface ExtensionRouteServer {
  /** Upgrades the request to a socket bridged to `socket.upstream`. */
  upgrade(
    req: Request,
    socket: ExtensionProxySocket,
    headers?: HeadersInit,
  ): boolean;
  /** Bun's per-request idle timeout in seconds; 0 turns it off. */
  timeout(req: Request, seconds: number): void;
}

export interface ExtensionRoutesOptions {
  registry: ExtensionRegistry;
  host: Pick<ExtensionHost, "answerOne">;
  tokens: WebhookTokens;
  caps: ProxyCaps;
}

/** A response, `"upgraded"` after a WebSocket upgrade, or null when not ours. */
export type ExtensionRouteResult = Response | "upgraded" | null;

const WEBHOOK_PATH = /^\/api\/ext\/([^/]+)\/hooks\/([^/]+)$/;
const PROXY_PATH = /^\/ext\/([^/]+)\/web\/_\/([^/]+)(\/.*)?$/;
const FRAME_PATH = /^\/ext\/([^/]+)\/frame\/(.+)$/;
const WEB_PATH = /^\/ext\/([^/]+)\/web(\/.*)?$/;
const CAP_PATH = /^\/api\/ext\/([^/]+)\/web-cap$/;
const CAP_BODY_LIMIT_BYTES = 16 * 1024;

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 308, headers: { location } });
}

export interface ExtensionRoutes {
  handlePublic(
    req: Request,
    url: URL,
    server: ExtensionRouteServer,
  ): Promise<ExtensionRouteResult>;
  handleAuthed(req: Request, url: URL): Promise<Response | null>;
  /** Ends every capability issued so far, e.g. on logout. */
  revokeCaps(): void;
}

/**
 * Extension HTTP surfaces (CONTRACT §7). `handlePublic` runs before the
 * session check: webhooks carry a bearer token and proxied documents a
 * capability, since opaque-origin frames send no cookies. `handleAuthed`
 * runs after it: frame assets, the proxy host page and capability renewal.
 */
export function createExtensionRoutes(
  options: ExtensionRoutesOptions,
): ExtensionRoutes {
  const { registry, host, tokens, caps } = options;

  /** An enabled, valid extension, or the response that says why not. */
  const target = (
    rawId: string,
  ): { manifest: ExtensionManifest; root: string } | Response => {
    const id = decoded(rawId);
    const record =
      id && EXTENSION_ID_PATTERN.test(id) ? registry.get(id) : undefined;
    const validation = record?.enabled ? registry.validate(record) : undefined;
    if (!validation?.manifest || validation.incompatible)
      return Response.json({ error: "unknown extension" }, { status: 404 });
    if (registry.safeMode())
      return Response.json(
        { error: "extensions are off (safe mode)" },
        { status: 503 },
      );
    return { manifest: validation.manifest, root: validation.root };
  };

  const capBase = (manifest: ExtensionManifest, cap: string) =>
    `/ext/${encodeURIComponent(manifest.id)}/web/_/${cap}`;

  async function proxied(
    req: Request,
    url: URL,
    server: ExtensionRouteServer,
    match: RegExpExecArray,
  ): Promise<ExtensionRouteResult> {
    const [, rawId = "", cap = "", sub] = match;
    const found = target(rawId);
    if (found instanceof Response) return found;
    const { manifest } = found;
    if (sub === undefined)
      return redirect(`${capBase(manifest, cap)}/${url.search}`);
    const route = proxyRouteFor(manifest, sub);
    if (!route) return new Response("not found", { status: 404 });
    if (caps.expiry(manifest.id, route.prefix, cap) === null)
      return new Response("capability expired or invalid", { status: 403 });
    const upstream = upstreamUrl(
      route.route,
      sub.slice(route.prefix.length),
      url.search,
    );
    if (!upstream)
      return new Response("upstream must be a loopback http URL", {
        status: 403,
      });
    const request: ProxyRequestTarget = {
      manifest,
      route: route.route,
      prefix: route.prefix,
      publicBase: capBase(manifest, cap),
      upstream,
    };
    // Streams and sockets stay open as long as both ends want.
    server.timeout(req, 0);
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return proxyHttp(req, request);
    const socket = await openUpstreamSocket(req, request);
    if (!socket) return notRunningPage(manifest);
    const protocol = socket.upstream.protocol;
    if (
      server.upgrade(
        req,
        socket,
        protocol ? { "sec-websocket-protocol": protocol } : undefined,
      )
    )
      return "upgraded";
    socket.upstream.close();
    return new Response("websocket upgrade failed", { status: 400 });
  }

  async function renewCap(
    req: Request,
    manifest: ExtensionManifest,
  ): Promise<Response> {
    if (req.method !== "POST")
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req, CAP_BODY_LIMIT_BYTES)) as Record<
        string,
        unknown
      >;
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
    const path = body?.path;
    if (typeof path !== "string" || !path.startsWith("/"))
      return Response.json(
        { error: "path must start with /" },
        { status: 400 },
      );
    const route = proxyRouteFor(manifest, path.split("?")[0] ?? "/");
    if (!route) return Response.json({ error: "no route" }, { status: 404 });
    const grant =
      (typeof body.cap === "string"
        ? caps.renew(manifest.id, route.prefix, body.cap)
        : null) ?? caps.mint(manifest.id, route.prefix);
    return Response.json(
      { ...grant, src: `${capBase(manifest, grant.cap)}${path}` },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return {
    async handlePublic(
      req: Request,
      url: URL,
      server: ExtensionRouteServer,
    ): Promise<ExtensionRouteResult> {
      const hook = WEBHOOK_PATH.exec(url.pathname);
      if (hook) {
        const found = target(hook[1] ?? "");
        if (found instanceof Response) return found;
        const name = decoded(hook[2] ?? "") ?? "";
        return handleWebhook(req, url, found.manifest, name, {
          tokens,
          dispatch: (ext, event) => host.answerOne(ext, event),
          hold: (seconds) => server.timeout(req, seconds),
        });
      }
      const proxy = PROXY_PATH.exec(url.pathname);
      if (proxy) return proxied(req, url, server, proxy);
      return null;
    },

    async handleAuthed(req: Request, url: URL): Promise<Response | null> {
      const frame = FRAME_PATH.exec(url.pathname);
      if (frame) {
        const found = target(frame[1] ?? "");
        if (found instanceof Response) return found;
        const segments = (frame[2] ?? "").split("/").map(decoded);
        if (segments.some((segment) => segment === null))
          return new Response("not found", { status: 404 });
        return serveFrameAsset(
          req,
          found.manifest,
          found.root,
          segments as string[],
        );
      }
      const cap = CAP_PATH.exec(url.pathname);
      if (cap) {
        const found = target(cap[1] ?? "");
        if (found instanceof Response) return found;
        return renewCap(req, found.manifest);
      }
      const web = WEB_PATH.exec(url.pathname);
      if (web) {
        const found = target(web[1] ?? "");
        if (found instanceof Response) return found;
        const { manifest } = found;
        const sub = web[2];
        if (sub === undefined)
          return redirect(
            `/ext/${encodeURIComponent(manifest.id)}/web/${url.search}`,
          );
        if (req.method !== "GET" && req.method !== "HEAD")
          return new Response("method not allowed", {
            status: 405,
            headers: { allow: "GET, HEAD" },
          });
        const route = proxyRouteFor(manifest, sub);
        if (!route) return new Response("not found", { status: 404 });
        return proxyHostPage({
          manifest,
          path: `${sub}${url.search}`,
          grant: caps.mint(manifest.id, route.prefix),
        });
      }
      return null;
    },

    revokeCaps: () => caps.revoke(),
  };
}
