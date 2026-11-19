import { readFileSync } from "node:fs";
import { EXTENSION_RPC_ERRORS } from "../../../shared/extensions";
import {
  assertSafeDataTreePath,
  ensureDataDirectory,
  replaceDataFile,
} from "../config/data-paths";
import type { ExtensionPaths } from "./paths";
import { ExtensionRpcError } from "./protocol";

export const STORE_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_KEY_LENGTH = 512;

/**
 * `$.store`: one JSON object per extension in its data directory. It survives
 * restarts and updates; every write replaces the file atomically, and a write
 * over the size limit leaves the previous contents in place.
 */
export class ExtensionStore {
  private values: Record<string, unknown> | null = null;

  constructor(
    private readonly paths: ExtensionPaths,
    private readonly id: string,
    private readonly limitBytes = STORE_LIMIT_BYTES,
  ) {}

  get(key: unknown): unknown {
    return this.load()[this.key(key)] ?? null;
  }

  keys(): string[] {
    return Object.keys(this.load());
  }

  set(key: unknown, value: unknown): void {
    const name = this.key(key);
    if (value === undefined) {
      this.delete(name);
      return;
    }
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(value);
    } catch (error) {
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.invalidParams,
        `store values must be JSON: ${(error as Error).message}`,
      );
    }
    if (encoded === undefined)
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.invalidParams,
        "store values must be JSON",
      );
    this.write({ ...this.load(), [name]: JSON.parse(encoded) });
  }

  delete(key: unknown): boolean {
    const name = this.key(key);
    const values = this.load();
    if (!Object.hasOwn(values, name)) return false;
    const next = { ...values };
    delete next[name];
    this.write(next);
    return true;
  }

  private key(key: unknown): string {
    if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH)
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.invalidParams,
        `store keys are strings of 1..${MAX_KEY_LENGTH} characters`,
      );
    return key;
  }

  private load(): Record<string, unknown> {
    if (this.values) return this.values;
    const file = this.paths.storeFile(this.id);
    assertSafeDataTreePath(this.paths.root, file);
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.values =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return this.values;
  }

  private write(values: Record<string, unknown>): void {
    const contents = `${JSON.stringify(values)}\n`;
    const size = Buffer.byteLength(contents);
    if (size > this.limitBytes)
      throw new ExtensionRpcError(
        EXTENSION_RPC_ERRORS.invalidParams,
        `store size limit exceeded: ${size} bytes over the ${this.limitBytes}-byte limit`,
      );
    ensureDataDirectory(this.paths.root, this.paths.dataDir(this.id));
    const file = this.paths.storeFile(this.id);
    assertSafeDataTreePath(this.paths.root, file);
    replaceDataFile(file, contents);
    this.values = values;
  }
}
