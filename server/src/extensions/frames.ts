import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  ExtensionFrameContribution,
  ExtensionManifest,
} from "../../../shared/extensions";
import { CSP_SOURCE, inside } from "./manifest";

type FrameCsp = NonNullable<ExtensionFrameContribution["csp"]>;

/**
 * The sandbox CSP of frame assets: an opaque origin with scripts, nothing
 * remote unless the frame declared it. `resource` domains may serve scripts,
 * styles, images, fonts and media, as MCP Apps resource domains do.
 */
export function frameCsp(csp: FrameCsp = {}): string {
  const declared = (sources: string[] | undefined) =>
    (sources ?? []).filter((source) => CSP_SOURCE.test(source));
  const resource = declared(csp.resource);
  const connect = declared(csp.connect);
  const frame = declared(csp.frame);
  const directive = (name: string, ...sources: string[]) =>
    `${name} ${[...sources, ...resource].join(" ")}`;
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    directive("script-src", "'self'", "'unsafe-inline'"),
    directive("style-src", "'self'", "'unsafe-inline'"),
    directive("img-src", "'self'", "data:"),
    directive("font-src", "'self'"),
    directive("media-src", "'self'"),
    ...(connect.length ? [`connect-src ${connect.join(" ")}`] : []),
    ...(frame.length ? [`frame-src ${frame.join(" ")}`] : []),
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

/**
 * `GET /ext/<id>/frame/<path>`: a file inside the extension root that is a
 * declared frame entry or sits in an entry's directory. Every path is
 * resolved through links before the containment checks.
 */
export function serveFrameAsset(
  req: Request,
  manifest: ExtensionManifest,
  root: string,
  segments: string[],
): Response {
  if (req.method !== "GET" && req.method !== "HEAD")
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  if (
    !segments.length ||
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\0") ||
        part.includes("/") ||
        part.includes("\\"),
    )
  )
    return notFound();
  let realRoot: string;
  let file: string;
  try {
    realRoot = realpathSync(root);
    file = realpathSync(resolve(realRoot, ...segments));
  } catch {
    return notFound();
  }
  if (!inside(realRoot, file)) return notFound();
  const frames = manifest.frames.flatMap((frame) => {
    try {
      const entry = realpathSync(resolve(realRoot, frame.entry));
      return inside(realRoot, entry) ? [{ frame, entry }] : [];
    } catch {
      return [];
    }
  });
  const exact = frames.filter((entry) => entry.entry === file);
  const serving = exact.length
    ? exact
    : frames.filter((entry) => inside(dirname(entry.entry), file));
  if (!serving.length) return notFound();
  try {
    if (!statSync(file).isFile()) return notFound();
  } catch {
    return notFound();
  }
  // An asset shared by several frames gets the union of their domains.
  const csp: FrameCsp = { connect: [], resource: [], frame: [] };
  for (const { frame } of serving)
    for (const key of ["connect", "resource", "frame"] as const)
      csp[key]?.push(...(frame.csp?.[key] ?? []));
  const body = Bun.file(file);
  return new Response(req.method === "HEAD" ? null : body, {
    headers: {
      "content-type": body.type,
      "content-security-policy": frameCsp(csp),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-cache",
    },
  });
}
