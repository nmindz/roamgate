import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ExtensionApiStability,
  ExtensionStatus,
} from "../../../shared/extensions";
import { readGuiSettings } from "../config/gui-settings";
import { describeMismatch } from "../extensions/analyze";
import {
  consentDiff,
  consentSummary,
  formatConsent,
  needsNewConsent,
} from "../extensions/consent";
import { extensionEnvironment } from "../extensions/guard";
import {
  ExtensionInstaller,
  type PreparedInstall,
  type ValidationReport,
} from "../extensions/install";
import {
  catalogInstallParams,
  MarketplaceStore,
} from "../extensions/marketplace";
import { type ExtensionPaths, extensionPaths } from "../extensions/paths";
import { openReceiptStore } from "../extensions/receipts";
import { ExtensionRegistry } from "../extensions/registry";
import {
  TESTING_PRELOAD,
  TESTING_SOURCES,
} from "../extensions/sdk/testing-sources";
import { SDK_TSCONFIG, SDK_TYPES } from "../extensions/sdk/types-source";
import {
  type CliCommand,
  type CliContext,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  parseCommandArgs,
  printJson,
  UsageError,
  wantsHelp,
} from "./command";
import {
  type ListenerProbe,
  probeListener,
  readServiceAccess,
  readServiceSetup,
  runtimeDataRoot,
} from "./service-context";

export interface ExtCommandDependencies {
  probe?: ListenerProbe;
  /** Asks the person at the terminal; false when nobody can answer. */
  confirm?: (question: string) => Promise<boolean>;
  strictValidation?: () => boolean | Promise<boolean>;
  paths?: (context: CliContext) => ExtensionPaths;
  /** Stability markers to check against; tests replace them. */
  stability?: ExtensionApiStability;
}

function extHelp(): string {
  return `Install and manage Roamgate extensions.

Usage:
  roamgate ext install <source> [--ref REF] [--sha256 HEX] [--yes]
  roamgate ext link <dir>
  roamgate ext unlink <id>
  roamgate ext uninstall <id> [--keep-data]
  roamgate ext enable <id> | disable <id>
  roamgate ext list [--json]
  roamgate ext info <id> [--json]
  roamgate ext update [id...] [--ref REF] [--yes]
  roamgate ext validate <dir> [--json]
  roamgate ext logs <id> [--lines N] [--follow]
  roamgate ext order <id...>
  roamgate ext receipts [id] [--limit N] [--json]
  roamgate ext test <dir> [-- <bun test arguments>]
  roamgate ext types [dir] | --output FILE
  roamgate ext marketplace add <source> | remove <name>
  roamgate ext marketplace list [--json] | refresh [name] [--json]

Sources: owner/repo[/subdir] on GitHub, any git URL, or an HTTPS archive URL
with --sha256. A local directory is linked and runs in place.


A marketplace is a roamgate-marketplace.json catalog in a GitHub repository,
a git repository, or at an HTTPS URL. Catalogs only list extensions; refresh
re-reads them and never installs or updates anything. Install a listed
extension with the command \`marketplace list\` prints, which pins its commit,
and \`ext update\` moves it to the catalog's current pin.

Installing and updating show what the extension can do and ask for consent;
non-interactive runs need --yes. Extensions run with your permissions and are
not sandboxed. With the service running, changes apply to it without a
restart; otherwise they apply when it starts.

\`ext test\` validates the extension, then runs \`bun test\` in its directory.
Test files import the fake host from "roamgate:testing":

  import { createFakeHost } from "roamgate:testing";
  const host = await createFakeHost({ dir: import.meta.dir });
  expect(await host.gate({ name: "pane.close", pane_id: "p1" }))
    .toEqual({ decision: "allow" });

It runs the mod in-process with an in-memory store and config, records
toasts, notifications, asks and processes, and answers other \`$\` calls
from host.stub("ns.method", value). Helpers: emit, gate, render, command.

\`ext types\` writes the SDK declarations as roamgate.d.ts in the directory
(the current one by default), and a tsconfig.json when it has none. Mods
then import types with \`import type { On } from "roamgate"\`.

Exit codes: 0 ok, 1 failure, 2 usage or validation errors.
`;
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = prompt(`${question} [y/N]`);
  return /^y(?:es)?$/i.test(answer?.trim() ?? "");
}

function status(
  registry: ExtensionRegistry,
  id: string,
): ExtensionStatus | "enabled" {
  const record = registry.get(id)!;
  const validation = registry.validate(record);
  if (!validation.manifest) return "invalid";
  if (validation.incompatible) return "incompatible";
  if (registry.safeMode()) return "safe_mode";
  if (!record.enabled) return record.auto_disabled ? "failed" : "disabled";
  return "enabled";
}

function tail(path: string, lines: number): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-lines);
}

export function createExtCommand(
  dependencies: ExtCommandDependencies = {},
): CliCommand {
  const confirm = dependencies.confirm ?? defaultConfirm;
  return {
    name: "ext",
    summary: "install and manage extensions",
    actions: [
      "install",
      "link",
      "unlink",
      "uninstall",
      "enable",
      "disable",
      "list",
      "info",
      "update",
      "validate",
      "logs",
      "order",
      "receipts",
      "test",
      "types",
      "marketplace",
    ],
    flags: [
      "--json",
      "--yes",
      "--ref",
      "--sha256",
      "--keep-data",
      "--lines",
      "--follow",
      "--limit",
      "--output",
    ],
    help: extHelp,
    async run(args, context) {
      const action = args[0];
      if (wantsHelp(args) || action === undefined) {
        context.log(extHelp());
        return EXIT_OK;
      }
      const rest = args.slice(1);
      const paths =
        dependencies.paths?.(context) ??
        extensionPaths(join(runtimeDataRoot(context.runtime), "extensions"));
      const registry = new ExtensionRegistry({
        paths,
        appVersion: context.version,
      });
      if (registry.loadError)
        throw new Error(`registry.json is unreadable: ${registry.loadError}`);
      const installer = new ExtensionInstaller({
        paths,
        registry,
        appVersion: context.version,
        strictValidation:
          dependencies.strictValidation ??
          (async () =>
            (await readGuiSettings()).extensions_strict_validation === true),
        stability: dependencies.stability,
      });
      const marketplaces = new MarketplaceStore({ paths });
      /** With a service running, it retires old versions once they drain. */
      const serviceRunning = async () => {
        try {
          const access = readServiceAccess(readServiceSetup(context.runtime));
          return await (dependencies.probe ?? probeListener)(access);
        } catch {
          return false;
        }
      };
      const applied = async (what: string) => {
        context.log(
          (await serviceRunning())
            ? `${what}; the running service picks it up now.`
            : `${what}; it applies when the service starts.`,
        );
      };
      const consentTo = async (
        prepared: PreparedInstall,
        yes: boolean,
        question: string,
      ) => {
        context.log(formatConsent(prepared.summary, prepared.diff));
        if (prepared.summary.mismatches.length)
          context.error(
            "warning: calls above need capabilities the manifest does not declare; they will fail",
          );
        if (yes || (await confirm(question))) return true;
        installer.discard(prepared);
        context.error(
          process.stdin.isTTY
            ? "Nothing was installed."
            : "Nothing was installed: non-interactive installs need --yes.",
        );
        return false;
      };

      switch (action) {
        case "install": {
          const { values, positionals } = parseCommandArgs(
            rest,
            {
              ref: { type: "string" },
              sha256: { type: "string" },
              yes: { type: "boolean" },
            },
            1,
          );
          const source = positionals[0];
          if (!source) throw new UsageError("install needs a source");
          const prepared = await installer.prepare(source, {
            ref: values.ref as string | undefined,
            sha256: values.sha256 as string | undefined,
          });
          if (!(await consentTo(prepared, values.yes === true, "Install?")))
            return EXIT_FAILURE;
          const running = await serviceRunning();
          const record = await installer.apply(prepared);
          if (!running) installer.prune(record.id);
          await applied(`Installed ${record.id} ${record.version}`);
          return EXIT_OK;
        }
        case "link": {
          const { positionals } = parseCommandArgs(rest, {}, 1);
          if (!positionals[0]) throw new UsageError("link needs a directory");
          const { record, summary } = await installer.link(positionals[0]);
          context.log(formatConsent(summary));
          await applied(`Linked ${record.id} from ${record.path}`);
          return EXIT_OK;
        }
        case "unlink": {
          const { positionals } = parseCommandArgs(rest, {}, 1);
          if (!positionals[0]) throw new UsageError("unlink needs an id");
          installer.unlink(positionals[0]);
          await applied(`Unlinked ${positionals[0]}`);
          return EXIT_OK;
        }
        case "uninstall": {
          const { values, positionals } = parseCommandArgs(
            rest,
            { "keep-data": { type: "boolean" } },
            1,
          );
          const id = positionals[0];
          if (!id) throw new UsageError("uninstall needs an id");
          installer.uninstall(id, {
            keepData: values["keep-data"] === true,
            prune: !(await serviceRunning()),
          });
          await applied(`Uninstalled ${id}`);
          return EXIT_OK;
        }
        case "enable":
        case "disable": {
          const { positionals } = parseCommandArgs(rest, {}, 1);
          if (!positionals[0]) throw new UsageError(`${action} needs an id`);
          registry.setEnabled(positionals[0], action === "enable");
          await applied(
            `${action === "enable" ? "Enabled" : "Disabled"} ${positionals[0]}`,
          );
          return EXIT_OK;
        }
        case "order": {
          const { positionals } = parseCommandArgs(rest, {}, Infinity);
          if (!positionals.length) throw new UsageError("order needs ids");
          registry.setOrder(positionals);
          await applied(
            `Order: ${registry
              .records()
              .map((r) => r.id)
              .join(", ")}`,
          );
          return EXIT_OK;
        }
        case "list": {
          const { values } = parseCommandArgs(rest, {
            json: { type: "boolean" },
          });
          const rows = registry.list().map(({ record, validation }) => ({
            id: record.id,
            version: validation.manifest?.version ?? record.version,
            status: status(registry, record.id),
            source: record.source,
            path: record.path,
          }));
          if (values.json) printJson(context, { extensions: rows });
          else if (!rows.length) context.log("No extensions installed.");
          else
            for (const row of rows)
              context.log(
                `${row.id}  ${row.version}  ${row.status}  ${row.source.kind} ${row.source.location}`,
              );
          return EXIT_OK;
        }
        case "info": {
          const { values, positionals } = parseCommandArgs(
            rest,
            { json: { type: "boolean" } },
            1,
          );
          const id = positionals[0];
          const record = id ? registry.get(id) : undefined;
          if (!id || !record) throw new UsageError(`unknown extension: ${id}`);
          const report = await installer.validate(record.path);
          const summary =
            report.validation.manifest && report.analysis
              ? consentSummary({
                  manifest: report.validation.manifest,
                  analysis: report.analysis,
                  source: record.source,
                  warnings: report.validation.warnings,
                })
              : undefined;
          if (values.json)
            printJson(context, {
              record,
              status: status(registry, id),
              errors: report.validation.errors,
              summary,
            });
          else {
            context.log(
              `Status: ${status(registry, id)}  Path: ${record.path}`,
            );
            for (const error of report.validation.errors)
              context.log(`error: ${error}`);
            if (summary)
              context.log(
                formatConsent(summary, consentDiff(record.consent, summary)),
              );
          }
          return EXIT_OK;
        }
        case "validate": {
          const { values, positionals } = parseCommandArgs(
            rest,
            { json: { type: "boolean" } },
            1,
          );
          if (!positionals[0])
            throw new UsageError("validate needs a directory");
          const report = await installer.validate(positionals[0]);
          const { validation, analysis } = report;
          const errors = validationErrors(report);
          const warnings = [
            ...validation.warnings,
            ...(analysis?.warnings ?? []),
          ];
          if (values.json)
            printJson(context, {
              ok: errors.length === 0,
              errors,
              warnings,
              incompatible: validation.incompatible ?? null,
              manifest: validation.manifest ?? null,
              analysis: analysis ?? null,
            });
          else {
            for (const error of errors) context.log(`error: ${error}`);
            for (const warning of warnings) context.log(`warning: ${warning}`);
            if (validation.incompatible)
              context.log(`incompatible: ${validation.incompatible}`);
            if (validation.manifest && analysis)
              context.log(
                formatConsent(
                  consentSummary({
                    manifest: validation.manifest,
                    analysis,
                    source: { kind: "link", location: validation.root },
                    warnings: validation.warnings,
                  }),
                ),
              );
          }
          return errors.length ? EXIT_USAGE : EXIT_OK;
        }
        case "update": {
          const { values, positionals } = parseCommandArgs(
            rest,
            { ref: { type: "string" }, yes: { type: "boolean" } },
            Infinity,
          );
          const ids = positionals.length
            ? positionals
            : registry
                .records()
                .filter((record) => record.source.kind !== "link")
                .map((record) => record.id);
          const running = await serviceRunning();
          let failed = false;
          for (const id of ids) {
            const record = registry.get(id);
            if (!record) throw new UsageError(`unknown extension: ${id}`);
            let prepared: PreparedInstall | null;
            try {
              prepared = await installer.prepareUpdate(
                id,
                values.ref !== undefined
                  ? { ref: values.ref as string }
                  : (marketplaces.updateParams(record) ?? {}),
              );
            } catch (error) {
              context.error(`${id}: ${(error as Error).message}`);
              failed = true;
              continue;
            }
            if (!prepared) {
              context.log(`${id} is up to date (${record.version}).`);
              continue;
            }
            context.log(
              `${id}: installed ${record.version} (${record.source.resolved ?? "unknown"}), available ${prepared.manifest.version} (${prepared.source.resolved})`,
            );
            const asks = prepared.diff && needsNewConsent(prepared.diff);
            if (
              !(await consentTo(
                prepared,
                values.yes === true,
                asks ? "Update and grant the added access?" : "Update?",
              ))
            ) {
              failed = true;
              continue;
            }
            try {
              const updated = await installer.apply(prepared);
              if (!running) installer.prune(id);
              await applied(`Updated ${id} to ${updated.version}`);
            } catch (error) {
              context.error(`${id}: ${(error as Error).message}`);
              failed = true;
            }
          }
          return failed ? EXIT_FAILURE : EXIT_OK;
        }
        case "logs": {
          const { values, positionals } = parseCommandArgs(
            rest,
            { lines: { type: "string" }, follow: { type: "boolean" } },
            1,
          );
          const id = positionals[0];
          if (!id) throw new UsageError("logs needs an id");
          const lines = Number(values.lines ?? 200);
          if (!Number.isInteger(lines) || lines <= 0)
            throw new UsageError("--lines must be a positive integer");
          const dir = paths.logsDir(id);
          const build = tail(join(dir, "build.log"), lines);
          if (build.length) context.log(["== build", ...build].join("\n"));
          const runtimeLog = join(dir, "extension.log");
          const recent = tail(runtimeLog, lines);
          if (recent.length) context.log(["== runtime", ...recent].join("\n"));
          if (!build.length && !recent.length && !values.follow)
            context.log(`No logs for ${id}.`);
          if (values.follow) await follow(runtimeLog, context);
          return EXIT_OK;
        }
        case "receipts": {
          const { values, positionals } = parseCommandArgs(
            rest,
            { limit: { type: "string" }, json: { type: "boolean" } },
            1,
          );
          const limit = Number(values.limit ?? 50);
          if (!Number.isInteger(limit) || limit <= 0)
            throw new UsageError("--limit must be a positive integer");
          const store = openReceiptStore(paths.receipts, {
            pruneEveryMs: null,
          });
          try {
            const rows = store.list({ ext: positionals[0], limit });
            if (values.json) printJson(context, { receipts: rows });
            else if (!rows.length) context.log("No approval receipts.");
            else
              for (const row of rows)
                context.log(
                  `${new Date(row.decided_at).toISOString()}  ${row.decision.padEnd(5)}  ${row.cause.padEnd(18)}  ${row.ext}  ${row.event}  ${row.title}${row.device ? `  (${row.device})` : ""}`,
                );
          } finally {
            store.close();
          }
          return EXIT_OK;
        }
        case "test": {
          const split = rest.indexOf("--");
          const { positionals } = parseCommandArgs(
            split < 0 ? rest : rest.slice(0, split),
            {},
            1,
          );
          if (!positionals[0]) throw new UsageError("test needs a directory");
          const report = await installer.validate(positionals[0]);
          const errors = validationErrors(report);
          for (const error of errors) context.error(`error: ${error}`);
          if (errors.length) return EXIT_USAGE;
          const code = await runExtensionTests(
            report.validation.root,
            split < 0 ? [] : rest.slice(split + 1),
            context,
          );
          return code === 0 ? EXIT_OK : EXIT_FAILURE;
        }
        case "types": {
          const { values, positionals } = parseCommandArgs(
            rest,
            { output: { type: "string" } },
            1,
          );
          if (values.output !== undefined) {
            if (positionals.length)
              throw new UsageError("types takes a directory or --output");
            const file = resolve(values.output);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, SDK_TYPES);
            context.log(`Wrote ${file}.`);
            return EXIT_OK;
          }
          const dir = resolve(positionals[0] ?? ".");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "roamgate.d.ts"), SDK_TYPES);
          context.log(`Wrote ${join(dir, "roamgate.d.ts")}.`);
          const tsconfig = join(dir, "tsconfig.json");
          if (existsSync(tsconfig))
            context.log(
              "tsconfig.json exists; make sure its include covers roamgate.d.ts.",
            );
          else {
            writeFileSync(tsconfig, SDK_TSCONFIG);
            context.log(`Wrote ${tsconfig}.`);
          }
          context.log(
            "For Bun and bun:test types, add @types/bun: bun add -d @types/bun",
          );
          return EXIT_OK;
        }
        case "marketplace": {
          const { values, positionals } = parseCommandArgs(
            rest,
            { json: { type: "boolean" } },
            2,
          );
          const [sub, argument] = positionals;
          if (sub === "add") {
            if (!argument)
              throw new UsageError("marketplace add needs a source");
            const info = await marketplaces.add(argument);
            if (values.json) printJson(context, { marketplace: info });
            else
              context.log(
                `Added marketplace ${info.name} (${info.entries} extensions). Nothing was installed.`,
              );
            return EXIT_OK;
          }
          if (sub === "remove") {
            if (!argument)
              throw new UsageError("marketplace remove needs a name");
            marketplaces.remove(argument);
            context.log(
              `Removed marketplace ${argument}; installed extensions stay.`,
            );
            return EXIT_OK;
          }
          if (sub === "list") {
            const rows = marketplaces.list().map((info) => ({
              ...info,
              extensions: marketplaces.catalog(info.name)?.extensions ?? [],
            }));
            if (values.json) printJson(context, { marketplaces: rows });
            else if (!rows.length) context.log("No marketplaces added.");
            else
              for (const row of rows) {
                context.log(
                  `${row.name}  ${row.kind} ${row.source}  refreshed ${new Date(row.refreshed_at).toISOString()}`,
                );
                for (const entry of row.extensions) {
                  const install = catalogInstallParams(entry);
                  context.log(
                    `  ${entry.id}${entry.version ? ` ${entry.version}` : ""}  ${entry.description}`,
                  );
                  context.log(
                    `    roamgate ext install ${install.source}${install.ref ? ` --ref ${install.ref}` : ""}${install.sha256 ? ` --sha256 ${install.sha256}` : ""}`,
                  );
                }
              }
            return EXIT_OK;
          }
          if (sub === "refresh") {
            const result = await marketplaces.refresh(argument);
            if (values.json) printJson(context, result);
            else {
              for (const info of result.marketplaces)
                context.log(
                  `Refreshed ${info.name} (${info.entries} extensions).`,
                );
              for (const failure of result.errors)
                context.error(`${failure.name}: ${failure.error}`);
            }
            return result.errors.length ? EXIT_FAILURE : EXIT_OK;
          }
          throw new UsageError(
            "marketplace needs add <source>, remove <name>, list or refresh [name]",
          );
        }
        default:
          throw new UsageError(`unknown ext action: ${action}`);
      }
    },
  };
}

/** Prints lines appended to `path` until interrupted. */
async function follow(path: string, context: CliContext): Promise<void> {
  let offset = existsSync(path) ? statSync(path).size : 0;
  const print = () => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const text = readFileSync(path).subarray(offset, size).toString("utf8");
    offset = size;
    for (const line of text.split("\n")) if (line) context.log(line);
  };
  const watcher = watch(join(path, ".."), () => print());
  const { promise, resolve } = Promise.withResolvers<void>();
  process.once("SIGINT", () => {
    watcher.close();
    resolve();
  });
  await promise;
}

/** Manifest, analysis and capability errors that make an extension invalid. */
function validationErrors(report: ValidationReport): string[] {
  const { validation, analysis } = report;
  const id = validation.manifest?.id ?? "the extension";
  return [
    ...validation.errors,
    ...(analysis?.errors ?? []),
    ...(analysis?.mismatches ?? []).map((mismatch) =>
      describeMismatch(id, mismatch),
    ),
    ...(report.refused ? [report.refused] : []),
  ];
}

async function forwardLines(
  stream: ReadableStream<Uint8Array>,
  sink: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split(
      /\r?\n/,
    );
    pending = lines.pop() ?? "";
    for (const line of lines) sink(line);
  }
  pending += decoder.decode();
  if (pending) sink(pending);
}

/**
 * Writes the fake host out (a compiled binary has no sources on disk) and
 * runs `bun test` in `root` with it preloaded; returns bun's exit code.
 */
async function runExtensionTests(
  root: string,
  args: string[],
  context: CliContext,
): Promise<number> {
  const sdk = mkdtempSync(join(tmpdir(), "roamgate-ext-sdk-"));
  try {
    for (const [path, text] of Object.entries(TESTING_SOURCES)) {
      const file = join(sdk, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    const proc = Bun.spawn(
      [
        process.execPath,
        "test",
        "--preload",
        join(sdk, TESTING_PRELOAD),
        ...args,
      ],
      {
        cwd: root,
        // BUN_BE_BUN makes a compiled roamgate act as the bun CLI.
        env: extensionEnvironment(process.env, { BUN_BE_BUN: "1" }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await Promise.all([
      forwardLines(proc.stdout, context.log),
      forwardLines(proc.stderr, context.error),
    ]);
    return await proc.exited;
  } finally {
    rmSync(sdk, { recursive: true, force: true });
  }
}
