import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionManifest,
  ExtensionWebhookEvent,
} from "../../../shared/extensions";
import {
  assertSafeDataTreePath,
  ensureDataDirectory,
  publishDataFile,
  replaceDataFile,
} from "../config/data-paths";
import { readJsonBody } from "../http/json-body";
import type { ExtensionPaths } from "./paths";

export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;
export const WEBHOOK_DEFAULT_TIMEOUT_S = 120;
export const WEBHOOK_MAX_TIMEOUT_S = 600;
const TOKEN_FILE = "webhook-token";

/** Where an extension's hooks live; `<base><name>` is one hook. */
export function webhookUrlBase(id: string): string {
  return `/api/ext/${encodeURIComponent(id)}/hooks/`;
}

/**
 * One bearer token per extension, in its data directory (0600). It is made
 * the first time someone asks to see it, so an extension nobody set up
 * accepts no webhook at all.
 */
export class WebhookTokens {
  constructor(private readonly paths: ExtensionPaths) {}

  private file(id: string): string {
    const file = join(this.paths.dataDir(id), TOKEN_FILE);
    assertSafeDataTreePath(this.paths.root, file);
    return file;
  }

  read(id: string): string | null {
    try {
      return readFileSync(this.file(id), "utf8").trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** The current token, created when there is none. */
  ensure(id: string): string {
    const existing = this.read(id);
    if (existing) return existing;
    // A concurrent creator wins; both callers then read the same token.
    this.write(id, false);
    return this.read(id) ?? "";
  }

  /** Replaces the token; the old one stops working at once. */
  rotate(id: string): string {
    this.write(id, true);
    return this.read(id) ?? "";
  }

  /** Constant-time check of a presented token. */
  matches(id: string, presented: string): boolean {
    let token: string | null;
    try {
      token = this.read(id);
    } catch {
      return false;
    }
    if (!token || !presented) return false;
    // Hashing first makes the comparison length-independent.
    return timingSafeEqual(
      createHash("sha256").update(token).digest(),
      createHash("sha256").update(presented).digest(),
    );
  }

  private write(id: string, replace: boolean): void {
    ensureDataDirectory(this.paths.root, this.paths.dataDir(id));
    const contents = `${randomBytes(32).toString("base64url")}\n`;
    if (replace) replaceDataFile(this.file(id), contents);
    else publishDataFile(this.file(id), contents);
  }
}

export interface WebhookOptions {
  tokens: WebhookTokens;
  /** Runs the extension's `webhook` handlers in answer mode. */
  dispatch(
    ext: string,
    event: ExtensionWebhookEvent,
  ): Promise<{ value: unknown } | { error: string }>;
  /** Keeps the HTTP connection open for this many seconds. */
  hold?(seconds: number): void;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * `POST /api/ext/<id>/hooks/<name>`. The response waits for the mod's answer,
 * including any `$.ui.ask` it makes, up to the route's timeout.
 */
export async function handleWebhook(
  req: Request,
  url: URL,
  manifest: ExtensionManifest,
  name: string,
  options: WebhookOptions,
): Promise<Response> {
  if (req.method !== "POST")
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  const presented =
    /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1] ??
    "";
  if (!options.tokens.matches(manifest.id, presented))
    return jsonError(401, "unauthorized");
  const route = manifest.capabilities.includes("http.routes")
    ? manifest.routes.find(
        (entry) => entry.kind === "webhook" && entry.name === name,
      )
    : undefined;
  if (!route) return jsonError(404, "unknown webhook");
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > WEBHOOK_BODY_LIMIT_BYTES)
    return jsonError(413, "body is over 1 MiB");
  let body: unknown;
  try {
    body = await readJsonBody(req, WEBHOOK_BODY_LIMIT_BYTES);
  } catch (error) {
    if (error instanceof RangeError)
      return jsonError(413, "body is over 1 MiB");
    return jsonError(400, "body must be JSON");
  }
  const timeoutS = Math.min(
    route.timeout ?? WEBHOOK_DEFAULT_TIMEOUT_S,
    WEBHOOK_MAX_TIMEOUT_S,
  );
  options.hold?.(timeoutS + 5);
  const event: ExtensionWebhookEvent = {
    name: "webhook",
    at: Date.now(),
    route: name,
    body,
    query: Object.fromEntries(url.searchParams),
  };
  const timedOut = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => timedOut.resolve("timeout"), timeoutS * 1000);
  try {
    const outcome = await Promise.race([
      options.dispatch(manifest.id, event),
      timedOut.promise,
    ]);
    if (outcome === "timeout")
      return jsonError(504, `no answer within ${timeoutS}s`);
    if ("error" in outcome) return jsonError(502, outcome.error);
    return Response.json(outcome.value ?? null);
  } finally {
    clearTimeout(timer);
  }
}
