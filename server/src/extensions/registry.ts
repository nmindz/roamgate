import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { basename } from "node:path";
import { EXTENSION_ID_PATTERN } from "../../../shared/extensions";
import {
  assertSafeDataTreePath,
  ensureDataDirectory,
  replaceDataFile,
} from "../config/data-paths";
import { type ManifestValidation, validateExtensionDir } from "./manifest";
import type { ExtensionPaths } from "./paths";

/** Failures within this window count towards automatic disabling. */
export const AUTO_DISABLE_WINDOW_MS = 10 * 60_000;
export const AUTO_DISABLE_FAILURES = 5;
const KEPT_FAILURES = 20;

export type ExtensionSourceKind = "github" | "git" | "archive" | "link";

export interface ExtensionRecord {
  id: string;
  source: {
    kind: ExtensionSourceKind;
    location: string;
    ref?: string;
    /** Commit SHA or archive digest the installed copy came from. */
    resolved?: string;
  };
  version: string;
  /** Installed version directory, or the linked directory. */
  path: string;
  enabled: boolean;
  order: number;
  consent?: {
    capabilities: string[];
    events: string[];
    hooks: string[];
    routes: string[];
    imports: string[];
    at: number;
  };
  /** Set when Roamgate disabled the extension after repeated failures. */
  auto_disabled?: { at: number; error: string };
  failures: Array<{ at: number; error: string }>;
}

interface RegistryFile {
  version: 1;
  safe_mode: boolean;
  extensions: ExtensionRecord[];
}

export interface RegisteredExtension {
  record: ExtensionRecord;
  validation: ManifestValidation;
}

export interface ExtensionRegistryOptions {
  paths: ExtensionPaths;
  appVersion: string;
  /** `--safe-mode` or ROAMGATE_SAFE_MODE: forces safe mode for this run. */
  safeModeFlag?: boolean;
  now?: () => number;
  platform?: string;
}

function isExtensionRecord(value: unknown): value is ExtensionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ExtensionRecord>;
  return (
    typeof record.id === "string" &&
    EXTENSION_ID_PATTERN.test(record.id) &&
    typeof record.path === "string" &&
    typeof record.version === "string" &&
    typeof record.enabled === "boolean" &&
    typeof record.order === "number" &&
    !!record.source &&
    typeof record.source.location === "string"
  );
}

/** `registry.json`: installed extensions, their order, state and failures. */
export class ExtensionRegistry {
  private file: RegistryFile = { version: 1, safe_mode: false, extensions: [] };
  private runtimeSafeMode: boolean | undefined;
  private readonly validations = new Map<
    string,
    { key: string; validation: ManifestValidation }
  >();
  private readonly now: () => number;

  constructor(private readonly options: ExtensionRegistryOptions) {
    this.now = options.now ?? Date.now;
    try {
      this.load();
    } catch (error) {
      this.loadError = (error as Error).message;
    }
  }

  /** Why registry.json could not be read; nothing runs or saves until it is fixed. */
  loadError: string | undefined;

  load(): void {
    const { registry, root } = this.options.paths;
    assertSafeDataTreePath(root, registry);
    let text: string;
    try {
      text = readFileSync(registry, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.written = text;
    const parsed = JSON.parse(text) as Partial<RegistryFile>;
    const seen = new Set<string>();
    const extensions: ExtensionRecord[] = [];
    for (const value of Array.isArray(parsed.extensions)
      ? parsed.extensions
      : []) {
      if (!isExtensionRecord(value) || seen.has(value.id)) continue;
      seen.add(value.id);
      extensions.push({
        ...value,
        failures: Array.isArray(value.failures) ? value.failures : [],
      });
    }
    this.file = {
      version: 1,
      safe_mode: parsed.safe_mode === true,
      extensions,
    };
  }

  /** Records in run order: the first is the outermost middleware. */
  records(): ExtensionRecord[] {
    return [...this.file.extensions].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    );
  }

  get(id: string): ExtensionRecord | undefined {
    return this.file.extensions.find((record) => record.id === id);
  }

  /** Every record with its manifest validated (cached until the manifest changes). */
  list(): RegisteredExtension[] {
    return this.records().map((record) => ({
      record,
      validation: this.validate(record),
    }));
  }

  validate(record: ExtensionRecord): ManifestValidation {
    let key: string;
    try {
      const stat = statSync(`${record.path}/roamgate-extension.toml`);
      key = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      key = "missing";
    }
    const cached = this.validations.get(record.id);
    if (cached?.key === key && key !== "missing") return cached.validation;
    const validation = validateExtensionDir(record.path, {
      appVersion: this.options.appVersion,
      platform: this.options.platform,
    });
    if (validation.manifest && validation.manifest.id !== record.id) {
      validation.errors.push(
        `manifest id ${JSON.stringify(validation.manifest.id)} does not match the installed id ${JSON.stringify(record.id)}`,
      );
      delete validation.manifest;
    }
    this.validations.set(record.id, { key, validation });
    return validation;
  }

  /** Drops a cached validation, so the manifest is read again. */
  forget(id: string): void {
    this.validations.delete(id);
  }

  /** Changes an installed record: a new version, source or consent. */
  update(
    id: string,
    patch: Partial<Omit<ExtensionRecord, "id" | "order" | "failures">>,
  ): ExtensionRecord {
    const record = this.require(id);
    Object.assign(record, patch);
    this.validations.delete(id);
    this.save();
    return record;
  }

  /**
   * Follows changes other processes (the `roamgate ext` CLI) make to
   * registry.json; this process's own writes are ignored.
   */
  watch(onChange: () => void): () => void {
    const { registry, root } = this.options.paths;
    ensureDataDirectory(root, root);
    const name = basename(registry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: FSWatcher;
    try {
      // The file is replaced on every write, so watch its directory.
      watcher = watch(root, (_event, file) => {
        if (file !== name) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          let text: string;
          try {
            text = readFileSync(registry, "utf8");
          } catch {
            return;
          }
          if (text === this.written) return;
          try {
            this.load();
            this.loadError = undefined;
          } catch (error) {
            this.loadError = (error as Error).message;
          }
          this.validations.clear();
          onChange();
        }, 50);
      });
    } catch {
      return () => undefined;
    }
    watcher.on("error", () => undefined);
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }

  /** Adds a record at the end of the order. Ids are unique across extensions. */
  add(record: Omit<ExtensionRecord, "order" | "failures">): ExtensionRecord {
    if (this.get(record.id))
      throw new Error(`extension already installed: ${record.id}`);
    const order =
      Math.max(-1, ...this.file.extensions.map((entry) => entry.order)) + 1;
    const added: ExtensionRecord = { ...record, order, failures: [] };
    this.file.extensions.push(added);
    this.save();
    return added;
  }

  remove(id: string): boolean {
    const before = this.file.extensions.length;
    this.file.extensions = this.file.extensions.filter(
      (record) => record.id !== id,
    );
    this.validations.delete(id);
    if (this.file.extensions.length === before) return false;
    this.save();
    return true;
  }

  setEnabled(id: string, enabled: boolean): ExtensionRecord {
    const record = this.require(id);
    record.enabled = enabled;
    if (enabled) {
      delete record.auto_disabled;
      record.failures = [];
    }
    this.save();
    return record;
  }

  /** Puts `ids` first, in that order; the others keep their relative order after them. */
  setOrder(ids: readonly string[]): void {
    for (const id of ids) this.require(id);
    const rest = this.records().filter((record) => !ids.includes(record.id));
    const ordered = [...ids.map((id) => this.require(id)), ...rest];
    for (const [index, record] of ordered.entries()) record.order = index;
    this.save();
  }

  /**
   * Records a handler failure. Returns true when this failure disabled the
   * extension (AUTO_DISABLE_FAILURES within AUTO_DISABLE_WINDOW_MS).
   */
  recordFailure(id: string, error: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    const at = this.now();
    record.failures = [...record.failures, { at, error }].slice(-KEPT_FAILURES);
    const recent = record.failures.filter(
      (failure) => at - failure.at <= AUTO_DISABLE_WINDOW_MS,
    );
    const disable = record.enabled && recent.length >= AUTO_DISABLE_FAILURES;
    if (disable) {
      record.enabled = false;
      record.auto_disabled = { at, error };
    }
    this.save();
    return disable;
  }

  safeMode(): boolean {
    return (
      this.loadError !== undefined ||
      (this.runtimeSafeMode ??
        (this.options.safeModeFlag === true || this.file.safe_mode))
    );
  }

  /** The runtime switch; persisted so a restart keeps extensions off. */
  setSafeMode(enabled: boolean): void {
    this.runtimeSafeMode = enabled;
    this.file.safe_mode = enabled;
    this.save();
  }

  private require(id: string): ExtensionRecord {
    const record = this.get(id);
    if (!record) throw new Error(`unknown extension: ${id}`);
    return record;
  }

  private save(): void {
    if (this.loadError)
      throw new Error(`registry.json is unreadable: ${this.loadError}`);
    const { registry, root } = this.options.paths;
    assertSafeDataTreePath(root, registry);
    const text = `${JSON.stringify(this.file, null, 2)}\n`;
    replaceDataFile(registry, text);
    this.written = text;
  }

  private written: string | undefined;
}
