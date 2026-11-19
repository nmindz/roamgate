import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_ID_PATTERN,
  MARKETPLACE_CATALOG_FILE,
  type MarketplaceBrowseEntry,
  type MarketplaceCatalog,
  type MarketplaceCatalogEntry,
  type MarketplaceInfo,
  type MarketplaceInstallParams,
} from "../../../shared/extensions";
import {
  assertSafeDataTreePath,
  ensureDataDirectory,
  replaceDataFile,
} from "../config/data-paths";
import {
  type ProcessRunOptions,
  type ProcessRunResult,
  runProcessWithCodeTimeout,
} from "../utils/process-utils";
import { extensionEnvironment } from "./guard";
import { parseInstallSource } from "./install";
import type { ExtensionPaths } from "./paths";
import type { ExtensionRecord, ExtensionRegistry } from "./registry";

const CATALOG_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const GITHUB_SHORTHAND =
  /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})((?:\/[A-Za-z0-9._-]+)*)$/;

type RunProcess = (
  argv: string[],
  timeoutMs: number,
  options?: ProcessRunOptions,
) => Promise<ProcessRunResult>;

/** Where a catalog comes from: a git repository, a URL, or a local file. */
export type MarketplaceSource =
  | { kind: "github" | "git"; url: string; subdir?: string }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string };

export function parseMarketplaceSource(input: string): MarketplaceSource {
  const value = input.trim();
  if (!value) throw new Error("marketplace add needs a source");
  if (/^file:\/\/.+\.json(?:[?#].*)?$/i.test(value))
    return { kind: "file", path: fileURLToPath(value.replace(/[?#].*$/, "")) };
  if (/^https?:\/\/.+\.json(?:[?#].*)?$/i.test(value)) {
    if (value.startsWith("http://"))
      throw new Error("marketplace URLs must use HTTPS");
    return { kind: "url", url: value };
  }
  if (
    /^(?:https?|ssh|git|file):\/\//.test(value) ||
    /^[\w.-]+@[\w.-]+:/.test(value)
  )
    return { kind: "git", url: value };
  if (existsSync(value)) {
    const path = resolve(value);
    return {
      kind: "file",
      path: statSync(path).isDirectory()
        ? join(path, MARKETPLACE_CATALOG_FILE)
        : path,
    };
  }
  const github = GITHUB_SHORTHAND.exec(value);
  if (github && !github[3]?.split("/").includes(".."))
    return {
      kind: "github",
      url: `https://github.com/${github[1]}/${github[2]}.git`,
      ...(github[3] ? { subdir: github[3].slice(1) } : {}),
    };
  throw new Error(
    `unrecognized marketplace ${JSON.stringify(value)}: use owner/repo[/subdir], a git URL, or an HTTPS URL to ${MARKETPLACE_CATALOG_FILE}`,
  );
}

function optionalString(
  entry: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error(`${where}: ${key} must be a string`);
  return value;
}

function catalogEntry(value: unknown, index: number): MarketplaceCatalogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`extensions[${index}] must be an object`);
  const entry = value as Record<string, unknown>;
  const where = `extensions[${index}]`;
  const id = entry.id;
  if (typeof id !== "string" || !EXTENSION_ID_PATTERN.test(id))
    throw new Error(`${where}: id must be an extension id`);
  const name = optionalString(entry, "name", where) ?? id;
  const description = optionalString(entry, "description", where) ?? "";
  const version = optionalString(entry, "version", where);
  const source = optionalString(entry, "source", where)?.trim();
  if (!source) throw new Error(`${where} (${id}): source is required`);
  const ref = optionalString(entry, "ref", where)?.toLowerCase();
  if (ref !== undefined && !COMMIT_SHA.test(ref))
    throw new Error(`${where} (${id}): ref must be a full 40-hex commit SHA`);
  const sha256 = optionalString(entry, "sha256", where)?.toLowerCase();
  if (sha256 !== undefined && !SHA256.test(sha256))
    throw new Error(`${where} (${id}): sha256 must be 64 hex digits`);
  let kind: string;
  try {
    kind = parseInstallSource(source, { sha256 }).kind;
  } catch (error) {
    throw new Error(`${where} (${id}): ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (kind === "archive" && ref)
    throw new Error(`${where} (${id}): archives pin with sha256, not ref`);
  if (kind !== "archive" && sha256)
    throw new Error(`${where} (${id}): git sources pin with ref, not sha256`);
  const tags = entry.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string"))
    throw new Error(`${where} (${id}): tags must be an array of strings`);
  return {
    id,
    name,
    description,
    ...(version !== undefined ? { version } : {}),
    source,
    ...(ref ? { ref } : {}),
    ...(sha256 ? { sha256 } : {}),
    tags,
  };
}

/** Parses and checks a `roamgate-marketplace.json` document. */
export function parseMarketplaceCatalog(text: string): MarketplaceCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${MARKETPLACE_CATALOG_FILE} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${MARKETPLACE_CATALOG_FILE} must be a JSON object`);
  const document = parsed as Record<string, unknown>;
  if (
    typeof document.name !== "string" ||
    !MARKETPLACE_NAME.test(document.name)
  )
    throw new Error(
      "catalog name must be 1-64 letters, digits, dots, dashes or underscores",
    );
  if (
    document.description !== undefined &&
    typeof document.description !== "string"
  )
    throw new Error("catalog description must be a string");
  if (!Array.isArray(document.extensions))
    throw new Error("catalog extensions must be an array");
  const extensions = document.extensions.map(catalogEntry);
  const seen = new Set<string>();
  for (const entry of extensions) {
    if (seen.has(entry.id))
      throw new Error(`catalog lists ${entry.id} more than once`);
    seen.add(entry.id);
  }
  return {
    name: document.name,
    ...(document.description ? { description: document.description } : {}),
    extensions,
  };
}

/** Installer arguments that fetch exactly the entry's pinned commit or archive. */
export function catalogInstallParams(
  entry: MarketplaceCatalogEntry,
): MarketplaceInstallParams {
  return {
    source: entry.source,
    ...(entry.ref ? { ref: entry.ref } : {}),
    ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
  };
}

/** The installed record came from this entry's source. */
function fromEntry(
  record: ExtensionRecord,
  entry: MarketplaceCatalogEntry,
): boolean {
  if (record.id !== entry.id || record.source.kind === "link") return false;
  // Archive URLs usually change per version, so the id and kind identify them.
  if (record.source.kind === "archive") return Boolean(entry.sha256);
  return !entry.sha256 && record.source.location === entry.source;
}

function pinOf(entry: MarketplaceCatalogEntry): string | undefined {
  if (entry.ref) return entry.ref;
  return entry.sha256 ? `sha256:${entry.sha256}` : undefined;
}

interface StoredMarketplace {
  name: string;
  source: string;
  kind: MarketplaceInfo["kind"];
  added_at: number;
  refreshed_at: number;
  commit?: string;
}

interface MarketplacesFile {
  version: 1;
  marketplaces: StoredMarketplace[];
}

export interface MarketplaceStoreOptions {
  paths: ExtensionPaths;
  runProcess?: RunProcess;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface MarketplaceRefreshResult {
  marketplaces: MarketplaceInfo[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Configured marketplaces in `marketplaces.json`, with each catalog cached as
 * `marketplaces/<name>.json`. Catalogs only list extensions; nothing here
 * installs, updates or enables one.
 */
export class MarketplaceStore {
  private readonly run: RunProcess;
  private readonly now: () => number;

  constructor(private readonly options: MarketplaceStoreOptions) {
    this.run = options.runProcess ?? runProcessWithCodeTimeout;
    this.now = options.now ?? Date.now;
  }

  list(): MarketplaceInfo[] {
    return this.load().marketplaces.map((stored) => this.info(stored));
  }

  catalog(name: string): MarketplaceCatalog | null {
    const file = this.catalogFile(name);
    if (!existsSync(file)) return null;
    try {
      return parseMarketplaceCatalog(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  async add(input: string): Promise<MarketplaceInfo> {
    const value = input.trim();
    const source = parseMarketplaceSource(value);
    const { catalog, commit } = await this.fetchCatalog(source);
    const file = this.load();
    const existing = file.marketplaces.find((m) => m.name === catalog.name);
    if (existing)
      throw new Error(
        `marketplace ${catalog.name} is already added from ${existing.source}; refresh it instead`,
      );
    const at = this.now();
    const stored: StoredMarketplace = {
      name: catalog.name,
      source: value,
      kind: source.kind,
      added_at: at,
      refreshed_at: at,
      ...(commit ? { commit } : {}),
    };
    this.writeCatalog(catalog);
    file.marketplaces.push(stored);
    this.save(file);
    return this.info(stored);
  }

  remove(name: string): void {
    const file = this.load();
    const index = file.marketplaces.findIndex((m) => m.name === name);
    if (index < 0) throw new Error(`unknown marketplace: ${name}`);
    file.marketplaces.splice(index, 1);
    this.save(file);
    const cached = this.catalogFile(name);
    assertSafeDataTreePath(this.options.paths.root, cached);
    rmSync(cached, { force: true });
  }

  /** Re-fetches one catalog, or all; a failed fetch keeps the cached copy. */
  async refresh(name?: string): Promise<MarketplaceRefreshResult> {
    const targets = this.load().marketplaces.filter(
      (m) => name === undefined || m.name === name,
    );
    if (name !== undefined && !targets.length)
      throw new Error(`unknown marketplace: ${name}`);
    const result: MarketplaceRefreshResult = { marketplaces: [], errors: [] };
    for (const target of targets) {
      try {
        const { catalog, commit } = await this.fetchCatalog(
          parseMarketplaceSource(target.source),
        );
        if (catalog.name !== target.name)
          throw new Error(
            `the catalog is now named ${catalog.name}; remove ${target.name} and add it again`,
          );
        this.writeCatalog(catalog);
        // Reload so a concurrent add or remove is kept.
        const file = this.load();
        const stored = file.marketplaces.find((m) => m.name === target.name);
        if (!stored) continue;
        stored.refreshed_at = this.now();
        if (commit) stored.commit = commit;
        else delete stored.commit;
        this.save(file);
        result.marketplaces.push(this.info(stored));
      } catch (error) {
        result.errors.push({
          name: target.name,
          error: (error as Error).message,
        });
      }
    }
    return result;
  }

  /** Every cached catalog entry with the state of any installed copy. */
  browse(registry: ExtensionRegistry, name?: string): MarketplaceBrowseEntry[] {
    const entries: MarketplaceBrowseEntry[] = [];
    for (const stored of this.load().marketplaces) {
      if (name !== undefined && stored.name !== name) continue;
      for (const entry of this.catalog(stored.name)?.extensions ?? []) {
        const record = registry.get(entry.id);
        let installed: MarketplaceBrowseEntry["installed"] = null;
        if (record) {
          const same = fromEntry(record, entry);
          const pin = pinOf(entry);
          const resolved = record.source.resolved?.toLowerCase();
          installed = {
            version: record.version,
            source: record.source.location,
            ...(record.source.resolved
              ? { resolved: record.source.resolved }
              : {}),
            enabled: record.enabled,
            pinned: same && pin !== undefined && resolved === pin,
            update_available:
              same &&
              ((pin !== undefined && resolved !== pin) ||
                (entry.version !== undefined &&
                  entry.version !== record.version)),
          };
        }
        entries.push({
          ...entry,
          marketplace: stored.name,
          install: catalogInstallParams(entry),
          installed,
        });
      }
    }
    return entries;
  }

  /**
   * What `ext update` should fetch for an extension installed from a catalog:
   * the entry's current pin, or undefined when no catalog lists its source.
   */
  updateParams(
    record: ExtensionRecord,
  ): { ref?: string; source?: string; sha256?: string } | undefined {
    for (const stored of this.load().marketplaces) {
      const entry = this.catalog(stored.name)?.extensions.find((e) =>
        fromEntry(record, e),
      );
      if (!entry) continue;
      if (entry.sha256) return { source: entry.source, sha256: entry.sha256 };
      return entry.ref ? { ref: entry.ref } : undefined;
    }
    return undefined;
  }

  private info(stored: StoredMarketplace): MarketplaceInfo {
    const catalog = this.catalog(stored.name);
    return {
      ...stored,
      ...(catalog?.description ? { description: catalog.description } : {}),
      entries: catalog?.extensions.length ?? 0,
    };
  }

  private catalogFile(name: string): string {
    if (!MARKETPLACE_NAME.test(name))
      throw new Error(`invalid marketplace name: ${JSON.stringify(name)}`);
    return join(this.options.paths.marketplaces, `${name}.json`);
  }

  private load(): MarketplacesFile {
    const { paths } = this.options;
    assertSafeDataTreePath(paths.root, paths.marketplacesFile);
    if (!existsSync(paths.marketplacesFile))
      return { version: 1, marketplaces: [] };
    const parsed = JSON.parse(readFileSync(paths.marketplacesFile, "utf8")) as
      | Partial<MarketplacesFile>
      | undefined;
    const marketplaces = Array.isArray(parsed?.marketplaces)
      ? parsed.marketplaces.filter(
          (m): m is StoredMarketplace =>
            !!m &&
            typeof m.name === "string" &&
            MARKETPLACE_NAME.test(m.name) &&
            typeof m.source === "string",
        )
      : [];
    return { version: 1, marketplaces };
  }

  private save(file: MarketplacesFile): void {
    const { paths } = this.options;
    ensureDataDirectory(paths.root, paths.root);
    assertSafeDataTreePath(paths.root, paths.marketplacesFile);
    replaceDataFile(
      paths.marketplacesFile,
      `${JSON.stringify(file, null, 2)}\n`,
    );
  }

  private writeCatalog(catalog: MarketplaceCatalog): void {
    const { paths } = this.options;
    ensureDataDirectory(paths.root, paths.marketplaces);
    const file = this.catalogFile(catalog.name);
    assertSafeDataTreePath(paths.root, file);
    replaceDataFile(file, `${JSON.stringify(catalog, null, 2)}\n`);
  }

  private async fetchCatalog(
    source: MarketplaceSource,
  ): Promise<{ catalog: MarketplaceCatalog; commit?: string }> {
    if (source.kind === "file") {
      if (!existsSync(source.path))
        throw new Error(`${source.path} does not exist`);
      if (statSync(source.path).size > CATALOG_MAX_BYTES)
        throw new Error("catalog is larger than 4 MiB");
      return {
        catalog: parseMarketplaceCatalog(readFileSync(source.path, "utf8")),
      };
    }
    if (source.kind === "url")
      return { catalog: await this.download(source.url) };
    return this.cloneCatalog(source);
  }

  private async download(url: string): Promise<MarketplaceCatalog> {
    const response = await (this.options.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`catalog download failed: HTTP ${response.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > CATALOG_MAX_BYTES)
        throw new Error("catalog is larger than 4 MiB");
      chunks.push(chunk);
    }
    return parseMarketplaceCatalog(Buffer.concat(chunks).toString("utf8"));
  }

  private async cloneCatalog(
    source: Extract<MarketplaceSource, { kind: "github" | "git" }>,
  ): Promise<{ catalog: MarketplaceCatalog; commit: string }> {
    const { paths } = this.options;
    const staging = join(paths.root, "staging", randomUUID());
    ensureDataDirectory(paths.root, staging);
    try {
      const dir = join(staging, "catalog");
      await this.git([
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--",
        source.url,
        dir,
      ]);
      const commit = await this.git(["rev-parse", "HEAD"], dir);
      const file = join(dir, source.subdir ?? "", MARKETPLACE_CATALOG_FILE);
      if (!existsSync(file))
        throw new Error(`the repository has no ${MARKETPLACE_CATALOG_FILE}`);
      if (statSync(file).size > CATALOG_MAX_BYTES)
        throw new Error("catalog is larger than 4 MiB");
      return {
        catalog: parseMarketplaceCatalog(readFileSync(file, "utf8")),
        commit,
      };
    } finally {
      rmSync(staging, { recursive: true, force: true });
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
}
