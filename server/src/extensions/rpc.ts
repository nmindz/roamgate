import {
  type ExtensionCommandRunParams,
  type ExtensionEventBase,
  type ExtensionFrameCallEvent,
  type ExtensionSlotContext,
  type ExtensionStateResult,
  type ExtensionsPush,
  type ExtensionUiRenderEntry,
  type ExtensionWebhookTokenResult,
  matchesEvent,
} from "../../../shared/extensions";
import type { ApprovalService } from "./approvals";
import { readExtensionConfig, writeExtensionConfig } from "./config";
import {
  consentDiff,
  consentRecord,
  consentSummary,
  needsNewConsent,
} from "./consent";
import type { ExtensionHost } from "./host";
import type { ExtensionInstaller, InstallPreviews } from "./install";
import type { MarketplaceStore } from "./marketplace";
import type { ExtensionPaths } from "./paths";
import type { ReceiptStore } from "./receipts";
import type { ExtensionRegistry } from "./registry";
import { type WebhookTokens, webhookUrlBase } from "./webhooks";

/** Bridge-global browser RPC methods all start with this prefix. */
export const EXTENSION_RPC_PREFIX = "ext.";

export interface ExtensionRpcOptions {
  registry: ExtensionRegistry;
  host: ExtensionHost;
  installer: ExtensionInstaller;
  previews: InstallPreviews;
  /** Sends one `{extensions: ...}` push to every browser. */
  broadcast: (push: ExtensionsPush) => void;
  approvals?: ApprovalService;
  receipts?: ReceiptStore | null;
  /** Where secrets.json lives; the default data root otherwise. */
  paths?: ExtensionPaths;
  /** Per-extension webhook bearer tokens, for `ext.manage` `webhook_token`. */
  webhookTokens?: WebhookTokens;
  /** Configured marketplace catalogs, for `ext.marketplace.*`. */
  marketplaces?: MarketplaceStore;
}

/** At most this many invalidations per extension and slot reach browsers per second. */
export const INVALIDATE_INTERVAL_MS = 100;

/**
 * Coalesces `$.ui.invalidate` per extension x slot: the first goes out at
 * once, later ones within the interval collapse into one trailing push.
 */
export function createInvalidateCoalescer(
  send: (ext: string, slot?: string) => void,
  intervalMs = INVALIDATE_INTERVAL_MS,
): (ext: string, slot?: string) => void {
  const windows = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; trailing: boolean }
  >();
  return (ext, slot) => {
    const key = `${ext}\u0000${slot ?? ""}`;
    const open = windows.get(key);
    if (open) {
      open.trailing = true;
      return;
    }
    send(ext, slot);
    const close = () => {
      const entry = windows.get(key);
      if (!entry?.trailing) {
        windows.delete(key);
        return;
      }
      entry.trailing = false;
      send(ext, slot);
      entry.timer = setTimeout(close, intervalMs);
      entry.timer.unref?.();
    };
    const timer = setTimeout(close, intervalMs);
    timer.unref?.();
    windows.set(key, { timer, trailing: false });
  };
}

/** The connection a slot render or action was made for, from its context. */
function contextConnection(
  context: ExtensionSlotContext,
): Pick<ExtensionEventBase, "connection"> {
  return typeof context.connection_id === "string" &&
    typeof context.generation === "number"
    ? {
        connection: {
          id: context.connection_id,
          generation: context.generation,
        },
      }
    : {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

export interface ExtensionRpc {
  handles(method: string): boolean;
  handle(method: string, params: unknown): Promise<unknown>;
  /** Pushes the current state to every browser. */
  publishState(): void;
}

/** `ext.*` methods: state, management, commands and logs. */
export function createExtensionRpc(options: ExtensionRpcOptions): ExtensionRpc {
  const { registry, host, installer, previews } = options;
  const state = (): ExtensionStateResult => host.state();
  const publishState = () => options.broadcast({ state: state() });
  const applied = () => {
    host.sync();
    return state();
  };
  const manifestOf = (id: string) => {
    const record = registry.get(id);
    if (!record) throw new Error(`unknown extension: ${id}`);
    const manifest = registry.validate(record).manifest;
    if (!manifest) throw new Error(`${id} has an invalid manifest`);
    return { record, manifest };
  };
  const marketplaces = () => {
    if (!options.marketplaces) throw new Error("marketplaces are unavailable");
    return options.marketplaces;
  };

  const handlers: Record<string, (params: Record<string, unknown>) => unknown> =
    {
      "ext.state": () => state(),
      "ext.manage": async (params) => {
        const op = params.op;
        if (op === "enable" || op === "disable") {
          registry.setEnabled(requireString(params.id, "id"), op === "enable");
          return applied();
        }
        if (op === "order") {
          const ids = params.ids;
          if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
            throw new Error("ids must be an array of extension ids");
          registry.setOrder(ids);
          return applied();
        }
        if (op === "safe_mode") {
          if (typeof params.enabled !== "boolean")
            throw new Error("enabled must be true or false");
          registry.setSafeMode(params.enabled);
          return applied();
        }
        if (op === "uninstall") {
          // The host retires the running version, then its directory is pruned.
          installer.uninstall(requireString(params.id, "id"), {
            keepData: params.keep_data === true,
          });
          return applied();
        }
        if (op === "consent") {
          const { record, manifest } = manifestOf(
            requireString(params.id, "id"),
          );
          const report = await installer.validate(record.path);
          if (!report.analysis) throw new Error(`${record.id} is invalid`);
          const summary = consentSummary({
            manifest,
            analysis: report.analysis,
            source: record.source,
            warnings: report.validation.warnings,
          });
          const diff = consentDiff(record.consent, summary);
          if (params.accept !== true)
            return { summary, diff, needs_consent: needsNewConsent(diff) };
          registry.update(record.id, { consent: consentRecord(summary) });
          return applied();
        }
        if (op === "webhook_token") {
          const { record } = manifestOf(requireString(params.id, "id"));
          if (!options.webhookTokens)
            throw new Error("webhooks are unavailable");
          return {
            token:
              params.rotate === true
                ? options.webhookTokens.rotate(record.id)
                : options.webhookTokens.ensure(record.id),
            url_base: webhookUrlBase(record.id),
          } satisfies ExtensionWebhookTokenResult;
        }
        throw new Error(`unsupported ext.manage op: ${String(op)}`);
      },
      "ext.install.preview": async (params) => {
        const source = requireString(params.source, "source");
        const prepared = await installer.prepare(source, {
          ref: typeof params.ref === "string" ? params.ref : undefined,
          sha256: typeof params.sha256 === "string" ? params.sha256 : undefined,
        });
        return {
          preview_id: previews.add(prepared),
          summary: prepared.summary,
          ...(prepared.existing
            ? {
                installed_version: prepared.existing.version,
                diff: prepared.diff,
              }
            : {}),
        };
      },
      "ext.install.apply": async (params) => {
        const prepared = previews.take(
          requireString(params.preview_id, "preview_id"),
        );
        const installed = await installer.apply(prepared);
        host.sync();
        return { record: installed, state: state() };
      },
      "ext.config.get": async (params) => {
        const { manifest } = manifestOf(requireString(params.ext, "ext"));
        return {
          schema: manifest.config,
          values: await readExtensionConfig(
            manifest,
            typeof params.connection_id === "string"
              ? params.connection_id
              : undefined,
            { paths: options.paths },
          ),
        };
      },
      "ext.config.set": async (params) => {
        const { manifest } = manifestOf(requireString(params.ext, "ext"));
        const key = requireString(params.key, "key");
        await writeExtensionConfig(
          manifest,
          key,
          params.value,
          typeof params.connection_id === "string"
            ? params.connection_id
            : undefined,
          options.paths,
        );
        void host.notifyConfigChange(manifest.id, [key]);
        return { ok: true };
      },
      "ext.command.run": async (params) => {
        const { ext, command, context } =
          params as unknown as ExtensionCommandRunParams;
        if (registry.safeMode())
          throw new Error("extensions are off (safe mode)");
        const result = await host.runCommand(
          requireString(ext, "ext"),
          requireString(command, "command"),
          { ...record(context), origin: "browser" },
        );
        return { result };
      },
      "ext.logs": (params) => {
        const limit =
          typeof params.limit === "number" && params.limit > 0
            ? Math.min(Math.floor(params.limit), 1_000)
            : 200;
        return { lines: host.logs(requireString(params.ext, "ext"), limit) };
      },
      "ext.approval.list": () => ({
        approvals: options.approvals?.list() ?? [],
      }),
      "ext.approval.answer": (params) => {
        const decision = params.decision;
        if (decision !== "approve" && decision !== "deny")
          throw new Error('decision must be "approve" or "deny"');
        if (!options.approvals) return { already_decided: true };
        return options.approvals.answer(
          requireString(params.id, "id"),
          decision,
          typeof params.device === "string"
            ? params.device.slice(0, 200)
            : null,
        );
      },
      "ext.receipts": (params) => ({
        rows:
          options.receipts?.list({
            ext: typeof params.ext === "string" ? params.ext : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
            before:
              typeof params.before === "number" ? params.before : undefined,
          }) ?? [],
      }),
      "ext.ui.render": async (params) => {
        const slot = requireString(params.slot, "slot");
        if (registry.safeMode()) return { entries: [] };
        const context = record(params.context) as ExtensionSlotContext;
        const viewer = record(params.viewer);
        const jobs: Array<Promise<ExtensionUiRenderEntry | null>> = [];
        for (const { id, manifest } of host.slotContributors(slot)) {
          // Only `slot:<slot>` activation starts a mod to render; otherwise a
          // stopped mod leaves its static entries to the browser.
          if (
            !host.isRunning(id) &&
            !manifest.activation.includes(`slot:${slot}`)
          )
            continue;
          const declared = manifest.slots.filter(
            (entry) => entry.slot === slot,
          );
          const entries = declared.length
            ? declared
            : [{ slot, id: "default", when: undefined }];
          for (const entry of entries) {
            // `when` is matched here so hidden entries never activate a mod.
            if (!matchesEvent(entry.when, context)) continue;
            const event: ExtensionEventBase = {
              ...context,
              name: "ui.render",
              at: Date.now(),
              origin: "browser",
              ...contextConnection(context),
              slot,
              entry_id: entry.id,
              context,
              viewer: {
                ...viewer,
                id: typeof viewer.id === "string" ? viewer.id : "",
                mobile: viewer.mobile === true,
              },
            };
            jobs.push(
              host.answerOne(id, event).then((answer) =>
                // Without a ui.render answer the browser keeps the manifest's static entry.
                "unanswered" in answer
                  ? null
                  : {
                      ext: id,
                      entry_id: entry.id,
                      value:
                        "error" in answer
                          ? { error: answer.error }
                          : answer.value,
                    },
              ),
            );
          }
        }
        return {
          entries: (await Promise.all(jobs)).filter(
            (entry): entry is ExtensionUiRenderEntry => entry !== null,
          ),
        };
      },
      "ext.ui.action": async (params) => {
        const ext = requireString(params.ext, "ext");
        const slot = requireString(params.slot, "slot");
        if (registry.safeMode())
          throw new Error("extensions are off (safe mode)");
        if (!host.slotContributors(slot).some((entry) => entry.id === ext))
          throw new Error(`${ext} contributes nothing to ${slot}`);
        const context = record(params.context) as ExtensionSlotContext;
        const answer = await host.answerOne(ext, {
          ...context,
          name: "ui.action",
          at: Date.now(),
          origin: "browser",
          ...contextConnection(context),
          slot,
          entry_id: requireString(params.entry_id, "entry_id"),
          element_id: requireString(params.element_id, "element_id"),
          value: params.value ?? null,
        });
        if ("error" in answer) throw new Error(answer.error);
        return { result: answer.value };
      },
      "ext.frame.call": async (params) => {
        const ext = requireString(params.ext, "ext");
        const frame = requireString(params.frame, "frame");
        if (registry.safeMode())
          throw new Error("extensions are off (safe mode)");
        const { manifest } = manifestOf(ext);
        if (!manifest.frames.some((entry) => entry.id === frame))
          throw new Error(`${ext} has no frame ${JSON.stringify(frame)}`);
        const event: ExtensionFrameCallEvent = {
          name: "frame.call",
          at: Date.now(),
          origin: "browser",
          frame,
          method: requireString(params.method, "method"),
          params: params.params ?? null,
        };
        const answer = await host.answerOne(ext, event);
        if ("error" in answer) throw new Error(answer.error);
        return { result: answer.value };
      },
      // No install method here: browse entries carry `install` params for
      // ext.install.preview, so catalog installs get the same consent screen.
      "ext.marketplace.list": () => ({ marketplaces: marketplaces().list() }),
      "ext.marketplace.add": async (params) => ({
        marketplace: await marketplaces().add(
          requireString(params.source, "source"),
        ),
      }),
      "ext.marketplace.remove": (params) => {
        marketplaces().remove(requireString(params.name, "name"));
        return { ok: true };
      },
      "ext.marketplace.refresh": (params) =>
        marketplaces().refresh(
          typeof params.name === "string" ? params.name : undefined,
        ),
      "ext.marketplace.browse": (params) => ({
        entries: marketplaces().browse(
          registry,
          typeof params.name === "string" ? params.name : undefined,
        ),
      }),
    };

  return {
    handles: (method) => Object.hasOwn(handlers, method),
    async handle(method, params) {
      const handler = handlers[method];
      if (!handler) throw new Error(`unknown extension method: ${method}`);
      return handler(record(params));
    },
    publishState,
  };
}
