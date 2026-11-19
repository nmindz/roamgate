import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  EXTENSION_MANIFEST_FILE,
  type ExtensionApiStability,
  type ExtensionManifest,
} from "../../../shared/extensions";
import {
  assertSafeDataTreePath,
  ensureDataDirectory,
} from "../config/data-paths";
import {
  type ProcessRunOptions,
  type ProcessRunResult,
  runProcessWithCodeTimeout,
} from "../utils/process-utils";
import { analyzeExtension, type ModAnalysis } from "./analyze";
import {
  type ConsentDiff,
  type ConsentSummary,
  consentDiff,
  consentRecord,
  consentSummary,
} from "./consent";
import { extensionEnvironment } from "./guard";
import {
  hostPlatform,
  type ManifestValidation,
  validateExtensionDir,
} from "./manifest";
import type { ExtensionPaths } from "./paths";
import type { ExtensionRecord, ExtensionRegistry } from "./registry";

export const BUILD_DEFAULT_TIMEOUT_MS = 300_000;
export const BUILD_MAX_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const GITHUB_SHORTHAND =
  /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})((?:\/[A-Za-z0-9._-]+)*)$/;

type RunProcess = (
  argv: string[],
  timeoutMs: number,
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

export type InstallSource =
  | { kind: "github" | "git"; location: string; url: string; subdir?: string }
  | { kind: "archive"; location: string; url: string; sha256: string };

/**
 * `owner/repo[/subdir]`, a git URL, or an HTTPS archive URL with its SHA-256.
 * Local directories are linked, never installed.
 */
export function parseInstallSource(
  input: string,
  options: { sha256?: string } = {},
): InstallSource {
  const value = input.trim();
  if (!value) throw new Error("install needs a source");
  if (
    /^(?:https?|file):\/\/.+\.(?:zip|tgz|tar\.gz|tar)(?:[?#].*)?$/i.test(value)
  ) {
    if (value.startsWith("http://"))
      throw new Error("archive URLs must use HTTPS");
    const sha256 = options.sha256?.trim().toLowerCase();
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256))
      throw new Error(
        "archive sources need --sha256 with the archive's SHA-256",
      );
    return { kind: "archive", location: value, url: value, sha256 };
  }
  if (
    /^(?:https?|ssh|git|file):\/\//.test(value) ||
    /^[\w.-]+@[\w.-]+:/.test(value)
  )
    return { kind: "git", location: value, url: value };
  const github = GITHUB_SHORTHAND.exec(value);
  if (github && !existsSync(value))
    return {
      kind: "github",
      location: value,
      url: `https://github.com/${github[1]}/${github[2]}.git`,
      ...(github[3] ? { subdir: github[3].slice(1) } : {}),
    };
  if (existsSync(value))
    throw new Error(
      `${value} is a local directory; use \`roamgate ext link ${value}\` to run it in place`,
    );
  throw new Error(
    `unrecognized source ${JSON.stringify(value)}: use owner/repo[/subdir], a git URL, or an HTTPS archive URL with --sha256`,
  );
}

/** A staged, analyzed extension waiting for consent. Nothing is installed yet. */
export interface PreparedInstall {
  id: string;
  manifest: ExtensionManifest;
  /** The extension directory inside the staging area. */
  root: string;
  staging: string;
  source: ExtensionRecord["source"];
  summary: ConsentSummary;
  analysis: ModAnalysis;
  /** Present when this replaces an installed version. */
  existing?: ExtensionRecord;
  diff?: ConsentDiff;
}

export interface ValidationReport {
  validation: ManifestValidation;
  analysis?: ModAnalysis;
  /** Set when strict validation refuses the mod. */
  refused?: string;
}

export interface ExtensionInstallerOptions {
  paths: ExtensionPaths;
  registry: ExtensionRegistry;
  appVersion: string;
  platform?: string;
  /** Refuse mods whose handlers or `$` calls static analysis cannot read. */
  strictValidation?: () => boolean | Promise<boolean>;
  runProcess?: RunProcess;
  fetch?: typeof fetch;
  /** Stability markers to check against; tests replace them. */
  stability?: ExtensionApiStability;
}

function versionDirName(version: string, resolved: string): string {
  const digest = resolved.replace(/^sha256:/, "").slice(0, 12);
  return `${version}-${digest}`.replace(/[^A-Za-z0-9._+-]/g, "_");
}

/** Install, link, update and uninstall, all on disk under the extensions root. */
export class ExtensionInstaller {
  private readonly run: RunProcess;

  constructor(private readonly options: ExtensionInstallerOptions) {
    this.run = options.runProcess ?? runProcessWithCodeTimeout;
  }

  /** Manifest validation plus static analysis, without running anything. */
  async validate(dir: string): Promise<ValidationReport> {
    const validation = validateExtensionDir(dir, {
      appVersion: this.options.appVersion,
      platform: this.options.platform,
      stability: this.options.stability,
    });
    if (!validation.manifest) return { validation };
    const analysis = analyzeExtension(
      validation.root,
      validation.manifest,
      this.options.stability,
    );
    const refused =
      analysis.unreadable.length && (await this.options.strictValidation?.())
        ? `strict validation refuses mods static analysis cannot read: ${analysis.unreadable.join("; ")}`
        : undefined;
    return { validation, analysis, ...(refused ? { refused } : {}) };
  }

  /** Fetches and analyzes a source into a staging directory. */
  async prepare(
    input: string,
    options: { ref?: string; sha256?: string } = {},
  ): Promise<PreparedInstall> {
    const source = parseInstallSource(input, options);
    return this.stage(source, options.ref);
  }

  /**
   * Fetches the installed source again, or `source` (a catalog's newer
   * archive); null when the same commit or digest.
   */
  async prepareUpdate(
    id: string,
    options: { ref?: string; source?: string; sha256?: string } = {},
  ): Promise<PreparedInstall | null> {
    const record = this.options.registry.get(id);
    if (!record) throw new Error(`unknown extension: ${id}`);
    if (record.source.kind === "link")
      throw new Error(
        `${id} is linked; it reloads from ${record.path} on its own`,
      );
    const source = options.source
      ? parseInstallSource(options.source, { sha256: options.sha256 })
      : record.source.kind === "archive"
        ? parseInstallSource(record.source.location, {
            sha256: record.source.resolved?.replace(/^sha256:/, ""),
          })
        : parseInstallSource(record.source.location);
    const prepared = await this.stage(source, options.ref ?? record.source.ref);
    if (
      prepared.id === id &&
      prepared.source.resolved === record.source.resolved &&
      prepared.manifest.version === record.version
    ) {
      this.discard(prepared);
      return null;
    }
    return prepared;
  }

  discard(prepared: PreparedInstall): void {
    rmSync(prepared.staging, { recursive: true, force: true });
  }

  /**
   * Installs a consented, prepared extension: copies it to its own version
   * directory, runs its build, then points the registry at it. A failed
   * build leaves the previous version active.
   */
  async apply(prepared: PreparedInstall): Promise<ExtensionRecord> {
    const { paths, registry } = this.options;
    try {
      const existing = registry.get(prepared.id);
      if (existing?.source.kind === "link")
        throw new Error(`${prepared.id} is linked; unlink it first`);
      const target = paths.versionDir(
        prepared.id,
        versionDirName(
          prepared.manifest.version,
          prepared.source.resolved ?? "",
        ),
      );
      if (existing?.path === target) return existing;
      ensureDataDirectory(paths.root, dirname(target));
      rmSync(target, { recursive: true, force: true });
      cpSync(prepared.root, target, {
        recursive: true,
        verbatimSymlinks: true,
      });
      rmSync(join(target, ".git"), { recursive: true, force: true });
      try {
        await this.build(prepared.id, prepared.manifest, target);
      } catch (error) {
        rmSync(target, { recursive: true, force: true });
        throw error;
      }
      const consent = consentRecord(prepared.summary);
      const fields = {
        source: prepared.source,
        version: prepared.manifest.version,
        path: target,
        consent,
      };
      return existing
        ? registry.update(prepared.id, fields)
        : registry.add({ id: prepared.id, enabled: true, ...fields });
    } finally {
      this.discard(prepared);
    }
  }

  /** Runs the live directory in place. Builds never run for links. */
  async link(
    dir: string,
  ): Promise<{ record: ExtensionRecord; summary: ConsentSummary }> {
    const report = await this.validate(dir);
    const { validation, analysis } = report;
    if (!validation.manifest || !analysis)
      throw new Error(validation.errors.join("; "));
    if (report.refused) throw new Error(report.refused);
    const source: ExtensionRecord["source"] = {
      kind: "link",
      location: validation.root,
    };
    const summary = consentSummary({
      manifest: validation.manifest,
      analysis,
      source,
      warnings: validation.warnings,
    });
    const { registry } = this.options;
    const existing = registry.get(validation.manifest.id);
    if (existing && existing.source.kind !== "link")
      throw new Error(
        `${validation.manifest.id} is already installed from ${existing.source.location}`,
      );
    const fields = {
      source,
      version: validation.manifest.version,
      path: validation.root,
      consent: consentRecord(summary),
    };
    const record = existing
      ? registry.update(existing.id, fields)
      : registry.add({ id: validation.manifest.id, enabled: true, ...fields });
    return { record, summary };
  }

  unlink(id: string): void {
    const record = this.options.registry.get(id);
    if (!record) throw new Error(`unknown extension: ${id}`);
    if (record.source.kind !== "link")
      throw new Error(`${id} is installed, not linked; use uninstall`);
    this.options.registry.remove(id);
  }

  /**
   * Removes the record and, unless kept, the data directory. Version
   * directories go now when `prune` is set, else once the service retires them.
   */
  uninstall(
    id: string,
    options: { keepData?: boolean; prune?: boolean } = {},
  ): void {
    const { paths, registry } = this.options;
    if (!registry.get(id)) throw new Error(`unknown extension: ${id}`);
    registry.remove(id);
    if (!options.keepData) {
      const data = paths.dataDir(id);
      assertSafeDataTreePath(paths.root, data, false);
      rmSync(data, { recursive: true, force: true });
    }
    if (options.prune) this.prune(id);
  }

  /** Deletes version directories of `id` that its record no longer uses. */
  prune(id: string): void {
    const { paths, registry } = this.options;
    const record = registry.get(id);
    const versions = dirname(paths.versionDir(id, "_"));
    if (!existsSync(versions)) return;
    assertSafeDataTreePath(paths.root, versions, false);
    for (const name of readdirSync(versions)) {
      const dir = join(versions, name);
      if (record && resolve(record.path) === resolve(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
    }
    if (!record || record.source.kind === "link")
      rmSync(versions, { recursive: true, force: true });
  }

  /** Where `[[build]]` output goes; `roamgate ext logs` shows it. */
  buildLogPath(id: string): string {
    return join(this.options.paths.logsDir(id), "build.log");
  }

  private async stage(
    source: InstallSource,
    ref: string | undefined,
  ): Promise<PreparedInstall> {
    const { paths } = this.options;
    const staging = join(paths.root, "staging", randomUUID());
    ensureDataDirectory(paths.root, staging);
    try {
      const fetched = join(staging, "source");
      let resolved: string;
      let root: string;
      if (source.kind === "archive") {
        resolved = `sha256:${await this.fetchArchive(source, staging, fetched)}`;
        root = this.archiveRoot(fetched);
      } else {
        resolved = await this.clone(source.url, fetched, ref);
        root = source.subdir ? join(fetched, source.subdir) : fetched;
      }
      const report = await this.validate(root);
      const { validation, analysis } = report;
      if (!validation.manifest || !analysis)
        throw new Error(
          `invalid extension: ${validation.errors.join("; ") || "no manifest"}`,
        );
      if (validation.incompatible) throw new Error(validation.incompatible);
      if (report.refused) throw new Error(report.refused);
      const recordSource: ExtensionRecord["source"] = {
        kind: source.kind,
        location: source.location,
        ...(ref ? { ref } : {}),
        resolved,
      };
      const summary = consentSummary({
        manifest: validation.manifest,
        analysis,
        source: recordSource,
        warnings: validation.warnings,
      });
      const existing = this.options.registry.get(validation.manifest.id);
      return {
        id: validation.manifest.id,
        manifest: validation.manifest,
        root: validation.root,
        staging,
        source: recordSource,
        summary,
        analysis,
        ...(existing
          ? { existing, diff: consentDiff(existing.consent, summary) }
          : {}),
      };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const result = await this.run(["git", ...args], GIT_TIMEOUT_MS, {
      ...(cwd ? { cwd } : {}),
      env: extensionEnvironment(process.env, {
        GIT_TERMINAL_PROMPT: "0",
        ...(process.env.SSH_AUTH_SOCK
          ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
          : {}),
      }),
    });
    if (result.code !== 0)
      throw new Error(
        `git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
      );
    return result.stdout.trim();
  }

  /** Clones and checks out `ref` (branch, tag or full commit SHA); returns the commit. */
  private async clone(
    url: string,
    dir: string,
    ref: string | undefined,
  ): Promise<string> {
    if (ref !== undefined && (!ref || ref.startsWith("-")))
      throw new Error(`invalid ref ${JSON.stringify(ref)}`);
    await this.git(["clone", "--quiet", "--filter=blob:none", "--", url, dir]);
    if (ref) await this.git(["checkout", "--quiet", ref, "--"], dir);
    const commit = await this.git(["rev-parse", "HEAD"], dir);
    if (
      ref &&
      COMMIT_SHA.test(ref) &&
      commit.toLowerCase() !== ref.toLowerCase()
    )
      throw new Error(`checked out ${commit}, not the requested ${ref}`);
    return commit;
  }

  /** Downloads an archive, checks its digest and unpacks it into `dir`. */
  private async fetchArchive(
    source: Extract<InstallSource, { kind: "archive" }>,
    staging: string,
    dir: string,
  ): Promise<string> {
    const response = await (this.options.fetch ?? fetch)(source.url, {
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`download failed: HTTP ${response.status}`);
    const hasher = new Bun.CryptoHasher("sha256");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > ARCHIVE_MAX_BYTES)
        throw new Error("archive is larger than 256 MiB");
      hasher.update(chunk);
      chunks.push(chunk);
    }
    const digest = hasher.digest("hex");
    if (digest !== source.sha256)
      throw new Error(
        `archive SHA-256 mismatch: expected ${source.sha256}, got ${digest}`,
      );
    const name = /\.zip(?:[?#].*)?$/i.test(source.url)
      ? "archive.zip"
      : "archive.tar.gz";
    const file = join(staging, name);
    await Bun.write(file, Buffer.concat(chunks));
    ensureDataDirectory(this.options.paths.root, dir);
    const argv =
      name === "archive.zip" && process.platform !== "win32"
        ? ["unzip", "-q", file, "-d", dir]
        : ["tar", "-xf", file, "-C", dir];
    const result = await this.run(argv, GIT_TIMEOUT_MS);
    if (result.code !== 0)
      throw new Error(
        `unpacking failed: ${(result.stderr || result.stdout).trim()}`,
      );
    return digest;
  }

  /** Archives often wrap the extension in one top-level directory. */
  private archiveRoot(dir: string): string {
    if (existsSync(join(dir, EXTENSION_MANIFEST_FILE))) return dir;
    const entries = readdirSync(dir);
    const only = entries.length === 1 ? join(dir, entries[0]!) : undefined;
    return only && statSync(only).isDirectory() ? only : dir;
  }

  /** Runs the `[[build]]` steps for this platform once, logging to build.log. */
  private async build(
    id: string,
    manifest: ExtensionManifest,
    dir: string,
  ): Promise<void> {
    const platform = hostPlatform(this.options.platform);
    const steps = manifest.build.filter(
      (step) =>
        !step.platforms || (platform && step.platforms.includes(platform)),
    );
    if (!steps.length) return;
    const { paths } = this.options;
    ensureDataDirectory(paths.root, paths.logsDir(id));
    const logPath = this.buildLogPath(id);
    const log = (text: string) =>
      appendFileSync(logPath, text, { mode: 0o600 });
    log(`\n== build ${manifest.version} at ${new Date().toISOString()}\n`);
    for (const step of steps) {
      const timeoutMs = Math.min(
        step.timeout ? step.timeout * 1000 : BUILD_DEFAULT_TIMEOUT_MS,
        BUILD_MAX_TIMEOUT_MS,
      );
      const bun = step.command[0] === "roamgate:bun";
      const argv = bun
        ? [process.execPath, ...step.command.slice(1)]
        : step.command;
      log(`$ ${JSON.stringify(step.command)}\n`);
      let result: ProcessRunResult;
      try {
        result = await this.run(argv, timeoutMs, {
          cwd: dir,
          env: extensionEnvironment(
            process.env,
            bun ? { BUN_BE_BUN: "1" } : {},
          ),
          maxOutputBytes: 4 * 1024 * 1024,
        });
      } catch (error) {
        log(`${(error as Error).message}\n`);
        throw new Error(
          `build failed: ${(error as Error).message}; the previous version stays active`,
          { cause: error },
        );
      }
      log(result.stdout);
      log(result.stderr);
      log(`exit ${result.code}\n`);
      if (result.code !== 0)
        throw new Error(
          `build failed: ${JSON.stringify(step.command)} exited ${result.code}; the previous version stays active`,
        );
    }
  }
}

/** Prepared installs waiting for consent in the browser, by preview id. */
export class InstallPreviews {
  private readonly pending = new Map<
    string,
    { prepared: PreparedInstall; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly installer: ExtensionInstaller,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  add(prepared: PreparedInstall): string {
    const id = randomUUID();
    const timer = setTimeout(() => this.drop(id), this.ttlMs);
    timer.unref?.();
    this.pending.set(id, { prepared, timer });
    return id;
  }

  take(id: string): PreparedInstall {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("install preview expired; preview it again");
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return entry.prepared;
  }

  drop(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.installer.discard(entry.prepared);
  }

  clear(): void {
    for (const id of [...this.pending.keys()]) this.drop(id);
  }
}
