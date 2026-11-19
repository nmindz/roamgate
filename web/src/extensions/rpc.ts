import type {
  ExtensionCapability,
  ExtensionLogLine,
  ExtensionSetting,
  ExtensionStateResult,
  MarketplaceBrowseEntry,
  MarketplaceInfo,
} from "../../../shared/extensions";
import { bridge } from "../api";

const PREVIEW_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

// Mirrors server/src/extensions/consent.ts and rpc.ts.

export interface ConsentSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: { kind: string; location: string; ref?: string; resolved?: string };
  capabilities: Array<{ id: ExtensionCapability; risk: string }>;
  events: string[];
  /** Action events the extension can allow, rewrite, ask about or deny. */
  gates: string[];
  hooks: Array<{ on: string; command: string[] }>;
  routes: string[];
  network_hosts: string[];
  build: Array<{ command: string[]; platforms?: string[] }>;
  imports: string[];
  calls: string[];
  mismatches: string[];
  unreadable: string[];
  warnings: string[];
  notice: string;
}

export const CONSENT_CATEGORIES = [
  "capabilities",
  "events",
  "hooks",
  "routes",
  "imports",
] as const;
export type ConsentDiff = Record<
  (typeof CONSENT_CATEGORIES)[number],
  { added: string[]; removed: string[] }
>;

export interface InstallPreview {
  preview_id: string;
  summary: ConsentSummary;
  installed_version?: string;
  diff?: ConsentDiff;
}

export interface ConsentCheck {
  summary: ConsentSummary;
  diff: ConsentDiff;
  needs_consent: boolean;
}

export interface ExtensionConfig {
  schema: Record<string, ExtensionSetting>;
  /** Secrets arrive as `{ set: true }` and never as their value. */
  values: Record<string, unknown>;
}

function isSummary(value: unknown): value is ConsentSummary {
  if (!value || typeof value !== "object") return false;
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "capabilities" in value &&
    Array.isArray(value.capabilities) &&
    "events" in value &&
    Array.isArray(value.events)
  );
}

export function extManage(params: Record<string, unknown>): Promise<unknown> {
  return bridge.call("ext.manage", params);
}

export function extLogs(ext: string, limit = 200): Promise<ExtensionLogLine[]> {
  return bridge
    .call("ext.logs", { ext, limit })
    .then((result) => (Array.isArray(result?.lines) ? result.lines : []));
}

export function extState(): Promise<ExtensionStateResult> {
  return bridge.call("ext.state");
}

/** Connection-scoped settings read and write against the active connection. */
export function extConfigGet(
  ext: string,
  connectionId?: string,
): Promise<ExtensionConfig> {
  return bridge
    .call("ext.config.get", {
      ext,
      ...(connectionId ? { connection_id: connectionId } : {}),
    })
    .then((result) => ({
      schema:
        result?.schema && typeof result.schema === "object"
          ? result.schema
          : {},
      values:
        result?.values && typeof result.values === "object"
          ? result.values
          : {},
    }));
}

export function extConfigSet(
  ext: string,
  key: string,
  value: unknown,
  connectionId?: string,
): Promise<unknown> {
  return bridge.call("ext.config.set", {
    ext,
    key,
    value,
    ...(connectionId ? { connection_id: connectionId } : {}),
  });
}

/** Consent state of an installed extension; `accept` records it. */
export function extConsent(id: string): Promise<ConsentCheck> {
  return extManage({ op: "consent", id }).then((result) => {
    const check = result as Partial<ConsentCheck> | null;
    if (!check || !isSummary(check.summary))
      throw new Error("The server returned no consent summary");
    return check as ConsentCheck;
  });
}

export function extConsentAccept(id: string): Promise<unknown> {
  return extManage({ op: "consent", id, accept: true });
}

export function extInstallPreview(
  source: string,
  ref?: string,
  sha256?: string,
): Promise<InstallPreview> {
  return bridge
    .call(
      "ext.install.preview",
      {
        source,
        ...(ref ? { ref } : {}),
        ...(sha256 ? { sha256 } : {}),
      },
      PREVIEW_TIMEOUT_MS,
    )
    .then((result) => {
      if (typeof result?.preview_id !== "string" || !isSummary(result.summary))
        throw new Error("The server returned no consent summary");
      return result as InstallPreview;
    });
}

export function extInstallApply(previewId: string): Promise<unknown> {
  return bridge.call(
    "ext.install.apply",
    { preview_id: previewId },
    INSTALL_TIMEOUT_MS,
  );
}

export function marketplaceList(): Promise<MarketplaceInfo[]> {
  return bridge
    .call("ext.marketplace.list")
    .then((result) =>
      Array.isArray(result?.marketplaces) ? result.marketplaces : [],
    );
}

export function marketplaceBrowse(
  name?: string,
): Promise<MarketplaceBrowseEntry[]> {
  return bridge
    .call("ext.marketplace.browse", name ? { name } : {})
    .then((result) => (Array.isArray(result?.entries) ? result.entries : []));
}

export function marketplaceAdd(source: string): Promise<unknown> {
  return bridge.call("ext.marketplace.add", { source }, PREVIEW_TIMEOUT_MS);
}

export function marketplaceRemove(name: string): Promise<unknown> {
  return bridge.call("ext.marketplace.remove", { name });
}

export function marketplaceRefresh(name?: string): Promise<unknown> {
  return bridge.call(
    "ext.marketplace.refresh",
    name ? { name } : {},
    PREVIEW_TIMEOUT_MS,
  );
}
