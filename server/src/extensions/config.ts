import { readFileSync } from "node:fs";
import type {
  ExtensionManifest,
  ExtensionSetting,
} from "../../../shared/extensions";
import {
  assertSafeDataTreePath,
  ensureDataDirectory,
  replaceDataFile,
} from "../config/data-paths";
import {
  connectionSettingsPrefix,
  readGuiSettings,
  updateGuiSettings,
} from "../config/gui-settings";
import { type ExtensionPaths, extensionPaths } from "./paths";
import type { ExtensionRegistry } from "./registry";

/**
 * Non-secret extension settings live in settings.json under
 * `extensions.<id>`; secrets live in the extension's `secrets.json` (0600).
 * Both key connection-scoped values with the connection prefix.
 */

function storageKey(
  key: string,
  setting: ExtensionSetting,
  connectionId?: string,
): string {
  return setting.scope === "connection"
    ? `${connectionSettingsPrefix(connectionId)}${key}`
    : key;
}

function readSecrets(
  paths: ExtensionPaths,
  id: string,
): Record<string, string> {
  const file = paths.secretsFile(id);
  assertSafeDataTreePath(paths.root, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export interface ReadConfigOptions {
  paths?: ExtensionPaths;
  /** Secret values instead of `{set}` markers; only for a mod with `secrets`. */
  revealSecrets?: boolean;
}

/** Every setting's value: stored, else its default. Secrets show only whether they are set. */
export async function readExtensionConfig(
  manifest: ExtensionManifest,
  connectionId?: string,
  options: ReadConfigOptions = {},
): Promise<Record<string, unknown>> {
  const stored = (await readGuiSettings()).extensions?.[manifest.id] ?? {};
  let secrets: Record<string, string> | undefined;
  const values: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(manifest.config)) {
    if (setting.type === "secret") {
      secrets ??= readSecrets(options.paths ?? extensionPaths(), manifest.id);
      const secret = secrets[storageKey(key, setting, connectionId)];
      values[key] = options.revealSecrets
        ? (secret ?? null)
        : { set: secret !== undefined };
      continue;
    }
    const value = stored[storageKey(key, setting, connectionId)];
    values[key] = value === undefined ? (setting.default ?? null) : value;
  }
  return values;
}

/**
 * The config a mod sees in `init` and through `$.config`: secret values only
 * when it declares the `secrets` capability.
 */
export function extensionConfigReader(
  registry: ExtensionRegistry,
  paths: ExtensionPaths,
): (id: string, connectionId?: string) => Promise<Record<string, unknown>> {
  return async (id, connectionId) => {
    const record = registry.get(id);
    const manifest = record && registry.validate(record).manifest;
    if (!manifest) return {};
    return readExtensionConfig(manifest, connectionId, {
      paths,
      revealSecrets: manifest.capabilities.includes("secrets"),
    });
  };
}

/** Checks a value against its setting's schema; returns the value to store. */
export function checkSettingValue(
  key: string,
  setting: ExtensionSetting,
  value: unknown,
): unknown {
  if (value === null || value === undefined) {
    if (setting.required) throw new Error(`${key} is required`);
    return undefined;
  }
  switch (setting.type) {
    case "boolean":
      if (typeof value !== "boolean")
        throw new Error(`${key} must be true or false`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${key} must be a number`);
      if (setting.min !== undefined && value < setting.min)
        throw new Error(`${key} must be at least ${setting.min}`);
      if (setting.max !== undefined && value > setting.max)
        throw new Error(`${key} must be at most ${setting.max}`);
      return value;
    case "select": {
      const allowed = (setting.options ?? []).map((option) =>
        typeof option === "string" ? option : option.value,
      );
      if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`${key} must be one of ${allowed.join(", ")}`);
      return value;
    }
    default:
      if (typeof value !== "string" || value.length > 4_096)
        throw new Error(`${key} must be text of at most 4096 characters`);
      return value;
  }
}

/** Stores one secret in the extension's secrets.json; null clears it. */
export function writeExtensionSecret(
  manifest: ExtensionManifest,
  key: string,
  value: unknown,
  connectionId?: string,
  paths: ExtensionPaths = extensionPaths(),
): void {
  const setting = manifest.config[key];
  if (setting?.type !== "secret")
    throw new Error(`${manifest.id} has no secret setting ${key}`);
  const checked =
    value === null || value === undefined
      ? undefined
      : checkSettingValue(key, setting, value);
  const secrets = readSecrets(paths, manifest.id);
  const stored = storageKey(key, setting, connectionId);
  if (checked === undefined) {
    if (!(stored in secrets)) return;
    delete secrets[stored];
  } else secrets[stored] = checked as string;
  ensureDataDirectory(paths.root, paths.dataDir(manifest.id));
  const file = paths.secretsFile(manifest.id);
  assertSafeDataTreePath(paths.root, file);
  replaceDataFile(file, `${JSON.stringify(secrets)}\n`, 0o600);
}

/** Stores one setting: secrets in secrets.json, the rest in settings.json. */
export async function writeExtensionConfig(
  manifest: ExtensionManifest,
  key: string,
  value: unknown,
  connectionId?: string,
  paths: ExtensionPaths = extensionPaths(),
): Promise<void> {
  const setting = manifest.config[key];
  if (!setting) throw new Error(`${manifest.id} has no setting ${key}`);
  if (setting.type === "secret") {
    writeExtensionSecret(manifest, key, value, connectionId, paths);
    return;
  }
  const checked = checkSettingValue(key, setting, value);
  const stored = storageKey(key, setting, connectionId);
  await updateGuiSettings((current) => {
    const own = { ...(current.extensions?.[manifest.id] ?? {}) };
    if (checked === undefined) delete own[stored];
    else own[stored] = checked;
    return {
      ...current,
      extensions: { ...current.extensions, [manifest.id]: own },
    };
  });
}
