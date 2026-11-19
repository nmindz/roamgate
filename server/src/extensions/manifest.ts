import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  API_STABILITY,
  type ApiStabilityMarker,
  CONTRIBUTION_ID_PATTERN,
  describeDeprecation,
  EXTENSION_API_VERSION,
  EXTENSION_CAPABILITIES,
  EXTENSION_ID_PATTERN,
  EXTENSION_MANIFEST_FILE,
  EXTENSION_PLATFORMS,
  EXTENSION_SLOTS,
  type ExtensionApiStability,
  type ExtensionCapability,
  type ExtensionManifest,
  type ExtensionMatcher,
  type ExtensionMatcherValue,
  type ExtensionPlatform,
  eventStability,
  isExtensionEvent,
} from "../../../shared/extensions";
import { keybindingKeyError, keybindingKeys } from "./keybindings";

export interface ManifestValidation {
  /** The extension directory after following links. */
  root: string;
  /** Present only when there are no errors. */
  manifest?: ExtensionManifest;
  errors: string[];
  warnings: string[];
  /** Set when the manifest is valid but cannot run on this Roamgate. */
  incompatible?: string;
}

export interface ManifestValidationOptions {
  appVersion: string;
  apiVersion?: string;
  platform?: string;
  /** Stability markers to check against; tests replace them. */
  stability?: ExtensionApiStability;
}

const TOP_LEVEL_KEYS = new Set([
  "id",
  "name",
  "version",
  "api",
  "min_roamgate_version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "platforms",
  "capabilities",
  "network_hosts",
  "mod",
  "activation",
  "experimental",
  "start_hint",
  "config",
  "build",
  "commands",
  "keybindings",
  "slots",
  "hooks",
  "routes",
  "frames",
  "themes",
  "link_patterns",
  "composer_commands",
  "previewers",
]);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const API_RANGE = /^(\^|~|>=)?\s*(\d+)\.(\d+)(?:\.(\d+))?$/;
/** A frame CSP host or scheme source: no keywords, separators or whitespace. */
export const CSP_SOURCE = /^[^\s;,'"]+$/;
const CAPABILITY_SET: ReadonlySet<string> = new Set(EXTENSION_CAPABILITIES);
const PLATFORM_SET: ReadonlySet<string> = new Set(EXTENSION_PLATFORMS);
const SLOT_SET: ReadonlySet<string> = new Set(EXTENSION_SLOTS);
const SETTING_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "select",
  "secret",
  "directory",
  "file",
]);

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function hostPlatform(
  platform: string = process.platform,
): ExtensionPlatform | null {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return null;
}

function versionParts(version: string): [number, number, number] | null {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether `range` (`^1.0`, `~1.2`, `>=1.0`, `1.0`) accepts API `version`. */
export function apiRangeAccepts(range: string, version: string): boolean {
  const match = API_RANGE.exec(range.trim());
  const [major, minor] = version.split(".").map(Number);
  if (!match || major === undefined || minor === undefined) return false;
  const wanted = [Number(match[2]), Number(match[3])];
  const actual = [major, minor];
  const operator = match[1];
  if (operator === ">=") return compareVersions(actual, wanted) >= 0;
  if (actual[0] !== wanted[0]) return false;
  if (operator === "^")
    return wanted[0] === 0
      ? actual[1] === wanted[1]
      : (actual[1] ?? 0) >= (wanted[1] ?? 0);
  return actual[1] === wanted[1];
}

/** Whether `path` is `root` or below it. */
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

class ManifestReader {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  constructor(
    readonly root: string,
    readonly stability: ExtensionApiStability = API_STABILITY,
  ) {}

  keys(table: Table, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(table)) {
      if (!allowed.includes(key))
        this.errors.push(`${path}: unknown key ${JSON.stringify(key)}`);
    }
  }

  string(
    table: Table,
    key: string,
    path: string,
    required = false,
  ): string | undefined {
    const value = table[key];
    if (value === undefined) {
      if (required) this.errors.push(`${path}.${key}: required`);
      return undefined;
    }
    if (typeof value !== "string" || (required && !value.trim())) {
      this.errors.push(`${path}.${key}: expected a non-empty string`);
      return undefined;
    }
    return value;
  }

  number(table: Table, key: string, path: string): number | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.errors.push(`${path}.${key}: expected a number`);
      return undefined;
    }
    return value;
  }

  boolean(table: Table, key: string, path: string): boolean | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      this.errors.push(`${path}.${key}: expected true or false`);
      return undefined;
    }
    return value;
  }

  strings(
    table: Table,
    key: string,
    path: string,
    required = false,
  ): string[] | undefined {
    const value = table[key];
    if (value === undefined) {
      if (required) this.errors.push(`${path}.${key}: required`);
      return undefined;
    }
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    ) {
      this.errors.push(`${path}.${key}: expected an array of strings`);
      return undefined;
    }
    return value as string[];
  }

  platforms(table: Table, path: string): ExtensionPlatform[] | undefined {
    const values = this.strings(table, "platforms", path);
    if (!values) return undefined;
    for (const value of values) {
      if (!PLATFORM_SET.has(value))
        this.errors.push(
          `${path}.platforms: unknown platform ${JSON.stringify(value)}`,
        );
    }
    return values as ExtensionPlatform[];
  }

  matcher(
    table: Table,
    key: string,
    path: string,
  ): ExtensionMatcher | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (!isTable(value)) {
      this.errors.push(`${path}.${key}: expected a table`);
      return undefined;
    }
    const valid = (item: unknown): item is ExtensionMatcherValue =>
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      (Array.isArray(item) && item.every(valid));
    for (const [field, item] of Object.entries(value)) {
      if (!valid(item))
        this.errors.push(
          `${path}.${key}.${field}: expected a string, number, boolean or array`,
        );
    }
    return value as ExtensionMatcher;
  }

  id(value: string | undefined, path: string): void {
    if (value !== undefined && !CONTRIBUTION_ID_PATTERN.test(value))
      this.errors.push(
        `${path}: ids use letters, digits, "_" and "-" (got ${JSON.stringify(value)})`,
      );
  }

  /** A `./` path that must stay inside the extension after following links. */
  path(value: string | undefined, path: string, mustExist: boolean): void {
    if (value === undefined) return;
    if (!value.startsWith("./")) {
      this.errors.push(
        `${path}: paths start with "./" (got ${JSON.stringify(value)})`,
      );
      return;
    }
    const target = resolve(this.root, value);
    if (!inside(this.root, target)) {
      this.errors.push(
        `${path}: ${JSON.stringify(value)} is outside the extension`,
      );
      return;
    }
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      if (mustExist)
        this.errors.push(`${path}: ${JSON.stringify(value)} not found`);
      return;
    }
    if (!inside(this.root, real))
      this.errors.push(
        `${path}: ${JSON.stringify(value)} resolves outside the extension`,
      );
    else if (mustExist && !statSync(real).isFile())
      this.errors.push(`${path}: ${JSON.stringify(value)} is not a file`);
  }

  argv(table: Table, path: string, required: boolean): string[] | undefined {
    const command = this.strings(table, "command", path, required);
    if (!command) return undefined;
    if (command.length === 0 || !command[0]) {
      this.errors.push(`${path}.command: expected a non-empty argv array`);
      return undefined;
    }
    for (const [index, item] of command.entries()) {
      if (item.startsWith("./") || item.startsWith("../"))
        this.path(item, `${path}.command[${index}]`, false);
    }
    return command;
  }

  entries(manifest: Table, key: string): Array<[Table, string]> {
    const value = manifest[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.errors.push(`${key}: expected an array of tables ([[${key}]])`);
      return [];
    }
    const entries: Array<[Table, string]> = [];
    for (const [index, entry] of value.entries()) {
      const path = `${key}[${index}]`;
      if (!isTable(entry)) this.errors.push(`${path}: expected a table`);
      else entries.push([entry, path]);
    }
    return entries;
  }

  unique(values: Array<string | undefined>, path: string): void {
    const seen = new Set<string>();
    for (const value of values) {
      if (value === undefined) continue;
      if (seen.has(value))
        this.errors.push(`${path}: duplicate id ${JSON.stringify(value)}`);
      seen.add(value);
    }
  }
}

export interface StabilityIssue {
  level: "error" | "warning";
  message: string;
}

/** An error for experimental use without the opt-in, a warning for deprecated use. */
export function stabilityIssue(
  api: string,
  marker: ApiStabilityMarker | undefined,
  experimental: boolean,
): StabilityIssue | null {
  if (marker?.stability === "experimental" && !experimental)
    return {
      level: "error",
      message: `${api} is experimental and needs experimental = true`,
    };
  if (marker?.stability === "deprecated")
    return { level: "warning", message: describeDeprecation(api, marker) };
  return null;
}

function checkEventName(
  reader: ManifestReader,
  event: string,
  path: string,
  experimental: boolean,
): void {
  if (!isExtensionEvent(event)) {
    reader.errors.push(`${path}: unknown event ${JSON.stringify(event)}`);
    return;
  }
  const issue = stabilityIssue(
    event,
    eventStability(event, reader.stability),
    experimental,
  );
  if (issue)
    (issue.level === "error" ? reader.errors : reader.warnings).push(
      `${path}: ${issue.message}`,
    );
}

const THEME_FILE_MAX_BYTES = 256 * 1024;

/** A theme file's JSON object, already checked to be a file inside the extension. */
function readThemeFile(
  reader: ManifestReader,
  file: string,
  path: string,
): Record<string, unknown> | undefined {
  const real = realpathSync(resolve(reader.root, file));
  if (statSync(real).size > THEME_FILE_MAX_BYTES) {
    reader.errors.push(`${path}: larger than 256 KiB`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(real, "utf8"));
  } catch (error) {
    reader.errors.push(`${path}: invalid JSON: ${(error as Error).message}`);
    return undefined;
  }
  if (isTable(parsed)) return parsed;
  reader.errors.push(`${path}: expected a JSON object`);
  return undefined;
}

/** Parse and validate `roamgate-extension.toml` in `dir` without running anything. */
export function validateExtensionDir(
  dir: string,
  options: ManifestValidationOptions,
): ManifestValidation {
  let root: string;
  try {
    root = realpathSync(resolve(dir));
  } catch {
    return {
      root: resolve(dir),
      errors: [`extension directory not found: ${dir}`],
      warnings: [],
    };
  }
  let source: string;
  try {
    source = readFileSync(join(root, EXTENSION_MANIFEST_FILE), "utf8");
  } catch {
    return {
      root,
      errors: [`${EXTENSION_MANIFEST_FILE} not found in ${root}`],
      warnings: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    return {
      root,
      errors: [`${EXTENSION_MANIFEST_FILE}: ${(error as Error).message}`],
      warnings: [],
    };
  }
  return validateManifest(parsed as Table, root, options);
}

export function validateManifest(
  raw: Table,
  root: string,
  options: ManifestValidationOptions,
): ManifestValidation {
  const reader = new ManifestReader(root, options.stability);
  const { errors, warnings } = reader;
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key))
      warnings.push(`unknown top-level key ${JSON.stringify(key)} ignored`);
  }

  const id = reader.string(raw, "id", "manifest", true);
  if (id !== undefined && !EXTENSION_ID_PATTERN.test(id))
    errors.push(
      `manifest.id: use 1-64 letters, digits, ".", "_" or "-" (got ${JSON.stringify(id)})`,
    );
  const name = reader.string(raw, "name", "manifest", true);
  const version = reader.string(raw, "version", "manifest", true);
  if (version !== undefined && !versionParts(version))
    errors.push(
      `manifest.version: expected SemVer (got ${JSON.stringify(version)})`,
    );
  const api = reader.string(raw, "api", "manifest", true);
  if (api !== undefined && !API_RANGE.test(api.trim()))
    errors.push(
      `manifest.api: expected a range like "^1.0" (got ${JSON.stringify(api)})`,
    );
  const minVersion = reader.string(raw, "min_roamgate_version", "manifest");
  if (minVersion !== undefined && !versionParts(minVersion))
    errors.push(
      `manifest.min_roamgate_version: expected SemVer (got ${JSON.stringify(minVersion)})`,
    );
  const experimental = reader.boolean(raw, "experimental", "manifest") ?? false;

  let author: ExtensionManifest["author"];
  if (raw.author !== undefined) {
    if (!isTable(raw.author)) errors.push("manifest.author: expected a table");
    else {
      reader.keys(raw.author, ["name", "url", "email"], "author");
      author = {
        name: reader.string(raw.author, "name", "author"),
        url: reader.string(raw.author, "url", "author"),
        email: reader.string(raw.author, "email", "author"),
      };
    }
  }

  const capabilities = (reader.strings(raw, "capabilities", "manifest") ??
    []) as ExtensionCapability[];
  for (const capability of capabilities) {
    if (!CAPABILITY_SET.has(capability))
      errors.push(
        `manifest.capabilities: unknown capability ${JSON.stringify(capability)}`,
      );
  }
  const networkHosts = reader.strings(raw, "network_hosts", "manifest") ?? [];
  for (const host of networkHosts) {
    if (!/^(?:\*\.)?[A-Za-z0-9.-]+(?::\d+)?$/.test(host))
      errors.push(
        `manifest.network_hosts: invalid host ${JSON.stringify(host)}`,
      );
  }
  const mod = reader.string(raw, "mod", "manifest");
  reader.path(mod, "manifest.mod", true);

  const commands = reader.entries(raw, "commands").map(([entry, path]) => {
    reader.keys(
      entry,
      ["id", "title", "icon", "keywords", "detail", "danger", "when"],
      path,
    );
    const commandId = reader.string(entry, "id", path, true);
    reader.id(commandId, `${path}.id`);
    return {
      id: commandId ?? "",
      title: reader.string(entry, "title", path, true) ?? "",
      icon: reader.string(entry, "icon", path),
      keywords: reader.strings(entry, "keywords", path),
      detail: reader.string(entry, "detail", path),
      danger: reader.boolean(entry, "danger", path),
      when: reader.matcher(entry, "when", path),
    };
  });
  reader.unique(
    commands.map((command) => command.id),
    "commands",
  );
  const commandIds = new Set(commands.map((command) => command.id));

  const activation = reader.strings(raw, "activation", "manifest") ?? [];
  for (const [index, trigger] of activation.entries()) {
    const path = `manifest.activation[${index}]`;
    if (trigger === "startup") continue;
    const [kind, value = ""] = trigger.split(/:(.*)/s);
    if (kind === "event") checkEventName(reader, value, path, experimental);
    else if (kind === "command") {
      reader.id(value, path);
      if (!commandIds.has(value))
        warnings.push(
          `${path}: command ${JSON.stringify(value)} is not declared in [[commands]]`,
        );
    } else if (kind === "slot") {
      if (!SLOT_SET.has(value))
        errors.push(`${path}: unknown slot ${JSON.stringify(value)}`);
    } else
      errors.push(
        `${path}: expected "startup", "event:<name>", "command:<id>" or "slot:<slot>"`,
      );
  }
  if (activation.length > 0 && mod === undefined)
    warnings.push("manifest.activation: ignored without a mod");

  const config: ExtensionManifest["config"] = {};
  if (raw.config !== undefined) {
    if (!isTable(raw.config)) errors.push("config: expected a table");
    else {
      for (const [key, setting] of Object.entries(raw.config)) {
        const path = `config.${key}`;
        reader.id(key, path);
        if (!isTable(setting)) {
          errors.push(`${path}: expected a table`);
          continue;
        }
        reader.keys(
          setting,
          [
            "type",
            "title",
            "description",
            "default",
            "required",
            "options",
            "min",
            "max",
            "scope",
          ],
          path,
        );
        const type = reader.string(setting, "type", path, true);
        if (type !== undefined && !SETTING_TYPES.has(type))
          errors.push(
            `${path}.type: unknown setting type ${JSON.stringify(type)}`,
          );
        const scope = reader.string(setting, "scope", path);
        if (scope !== undefined && scope !== "global" && scope !== "connection")
          errors.push(`${path}.scope: expected "global" or "connection"`);
        const fallback = setting.default;
        if (
          fallback !== undefined &&
          !["string", "number", "boolean"].includes(typeof fallback)
        )
          errors.push(`${path}.default: expected a string, number or boolean`);
        if (type === "secret" && fallback !== undefined)
          errors.push(`${path}.default: secrets cannot have a default`);
        const optionsValue = setting.options;
        if (
          optionsValue !== undefined &&
          !(
            Array.isArray(optionsValue) &&
            optionsValue.every(
              (option) =>
                typeof option === "string" ||
                (isTable(option) &&
                  typeof option.value === "string" &&
                  typeof option.label === "string" &&
                  Object.keys(option).every(
                    (k) => k === "value" || k === "label",
                  )),
            )
          )
        )
          errors.push(
            `${path}.options: expected strings or { value, label } tables`,
          );
        config[key] = {
          type: (type ??
            "string") as ExtensionManifest["config"][string]["type"],
          title: reader.string(setting, "title", path, true) ?? key,
          description: reader.string(setting, "description", path),
          default: fallback as string | number | boolean | undefined,
          required: reader.boolean(setting, "required", path),
          options:
            optionsValue as ExtensionManifest["config"][string]["options"],
          min: reader.number(setting, "min", path),
          max: reader.number(setting, "max", path),
          scope: scope as "global" | "connection" | undefined,
        };
      }
    }
  }

  const build = reader.entries(raw, "build").map(([entry, path]) => {
    reader.keys(entry, ["command", "platforms", "timeout"], path);
    const timeout = reader.number(entry, "timeout", path);
    if (timeout !== undefined && (timeout <= 0 || timeout > 3600))
      errors.push(`${path}.timeout: expected 1..3600 seconds`);
    return {
      command: reader.argv(entry, path, true) ?? [],
      platforms: reader.platforms(entry, path),
      timeout,
    };
  });

  const boundKeys = new Map<string, string>();
  const keybindings = reader
    .entries(raw, "keybindings")
    .map(([entry, path]) => {
      reader.keys(entry, ["command", "key", "when"], path);
      const command = reader.string(entry, "command", path, true) ?? "";
      if (command && !commandIds.has(command))
        errors.push(
          `${path}.command: ${JSON.stringify(command)} is not declared in [[commands]]`,
        );
      const key = reader.string(entry, "key", path, true) ?? "";
      const keyError = key ? keybindingKeyError(key) : null;
      if (keyError) errors.push(`${path}.key: ${keyError}`);
      else
        for (const [platform, normalized] of Object.entries(
          keybindingKeys(key) ?? {},
        )) {
          const earlier = boundKeys.get(`${platform}:${normalized}`);
          if (earlier)
            errors.push(
              `${path}.key: ${normalized} is already bound by ${earlier} on ${platform}`,
            );
          else boundKeys.set(`${platform}:${normalized}`, path);
        }
      return {
        command,
        key,
        when: reader.matcher(entry, "when", path),
      };
    });

  const slots = reader.entries(raw, "slots").map(([entry, path]) => {
    reader.keys(
      entry,
      [
        "slot",
        "id",
        "title",
        "detail",
        "text",
        "icon",
        "tone",
        "tooltip",
        "command",
        "danger",
        "when",
      ],
      path,
    );
    const slot = reader.string(entry, "slot", path, true) ?? "";
    if (slot && !SLOT_SET.has(slot))
      errors.push(`${path}.slot: unknown slot ${JSON.stringify(slot)}`);
    const slotId = reader.string(entry, "id", path, true);
    reader.id(slotId, `${path}.id`);
    const tone = reader.string(entry, "tone", path);
    if (
      tone !== undefined &&
      !["neutral", "info", "success", "warning", "danger"].includes(tone)
    )
      errors.push(`${path}.tone: unknown tone ${JSON.stringify(tone)}`);
    const command = reader.string(entry, "command", path);
    if (command !== undefined && !commandIds.has(command))
      errors.push(
        `${path}.command: ${JSON.stringify(command)} is not declared in [[commands]]`,
      );
    return {
      slot,
      id: slotId ?? "",
      title: reader.string(entry, "title", path),
      detail: reader.string(entry, "detail", path),
      text: reader.string(entry, "text", path),
      icon: reader.string(entry, "icon", path),
      tone: tone as ExtensionManifest["slots"][number]["tone"],
      tooltip: reader.string(entry, "tooltip", path),
      command,
      danger: reader.boolean(entry, "danger", path),
      when: reader.matcher(entry, "when", path),
    };
  });
  reader.unique(
    slots.map((slot) => `${slot.slot}:${slot.id}`),
    "slots",
  );

  const hooks = reader.entries(raw, "hooks").map(([entry, path]) => {
    reader.keys(
      entry,
      ["on", "matcher", "command", "url", "timeout", "on_failure", "platforms"],
      path,
    );
    const on = reader.string(entry, "on", path, true) ?? "";
    if (on) checkEventName(reader, on, `${path}.on`, experimental);
    const command = reader.argv(entry, path, false);
    const url = reader.string(entry, "url", path);
    if ((command === undefined) === (url === undefined))
      errors.push(`${path}: set exactly one of command or url`);
    if (url !== undefined) {
      const error = hookUrlError(url, networkHosts);
      if (error) errors.push(`${path}.url: ${error}`);
    }
    const timeout = reader.number(entry, "timeout", path);
    if (timeout !== undefined && (timeout <= 0 || timeout > 600))
      errors.push(`${path}.timeout: expected 1..600 seconds`);
    const onFailure = reader.string(entry, "on_failure", path);
    if (
      onFailure !== undefined &&
      onFailure !== "continue" &&
      onFailure !== "block"
    )
      errors.push(`${path}.on_failure: expected "continue" or "block"`);
    return {
      on,
      matcher: reader.matcher(entry, "matcher", path),
      command,
      url,
      timeout,
      on_failure: onFailure as "continue" | "block" | undefined,
      platforms: reader.platforms(entry, path),
    };
  });

  const routes = reader.entries(raw, "routes").map(([entry, path]) => {
    reader.keys(entry, ["kind", "name", "upstream", "path", "timeout"], path);
    const kind = reader.string(entry, "kind", path, true);
    const routeName = reader.string(entry, "name", path);
    const upstream = reader.string(entry, "upstream", path);
    if (kind === "webhook") {
      if (routeName === undefined)
        errors.push(`${path}.name: required for webhooks`);
      reader.id(routeName, `${path}.name`);
    } else if (kind === "proxy") {
      if (
        upstream === undefined ||
        !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(
          upstream,
        )
      )
        errors.push(
          `${path}.upstream: expected an http URL on 127.0.0.1, ::1 or localhost`,
        );
    } else if (kind !== undefined) {
      errors.push(`${path}.kind: expected "webhook" or "proxy"`);
    }
    const routePath = reader.string(entry, "path", path);
    if (
      routePath !== undefined &&
      (!routePath.startsWith("/") || routePath.split("/").includes(".."))
    )
      errors.push(`${path}.path: expected an absolute path like "/"`);
    const timeout = reader.number(entry, "timeout", path);
    if (timeout !== undefined && (timeout <= 0 || timeout > 600))
      errors.push(`${path}.timeout: expected 1..600 seconds`);
    return {
      kind: (kind ?? "webhook") as "webhook" | "proxy",
      name: routeName,
      upstream,
      path: routePath,
      timeout,
    };
  });

  const frames = reader.entries(raw, "frames").map(([entry, path]) => {
    reader.keys(entry, ["id", "entry", "height", "csp"], path);
    const frameId = reader.string(entry, "id", path, true);
    reader.id(frameId, `${path}.id`);
    const frameEntry = reader.string(entry, "entry", path, true);
    reader.path(frameEntry, `${path}.entry`, true);
    let csp: ExtensionManifest["frames"][number]["csp"];
    if (entry.csp !== undefined) {
      if (!isTable(entry.csp)) errors.push(`${path}.csp: expected a table`);
      else {
        reader.keys(entry.csp, ["connect", "resource", "frame"], `${path}.csp`);
        csp = {
          connect: reader.strings(entry.csp, "connect", `${path}.csp`),
          resource: reader.strings(entry.csp, "resource", `${path}.csp`),
          frame: reader.strings(entry.csp, "frame", `${path}.csp`),
        };
        for (const [list, sources] of Object.entries(csp))
          for (const source of sources ?? [])
            if (!CSP_SOURCE.test(source))
              errors.push(
                `${path}.csp.${list}: ${JSON.stringify(source)} is not a CSP host or scheme source`,
              );
      }
    }
    return {
      id: frameId ?? "",
      entry: frameEntry ?? "",
      height: reader.number(entry, "height", path),
      csp,
    };
  });
  reader.unique(
    frames.map((frame) => frame.id),
    "frames",
  );
  const frameIds = new Set(frames.map((frame) => frame.id));

  const themes = reader.entries(raw, "themes").map(([entry, path]) => {
    reader.keys(entry, ["kind", "file", "id", "name"], path);
    const kind = reader.string(entry, "kind", path, true);
    if (kind !== undefined && kind !== "terminal" && kind !== "accent")
      errors.push(`${path}.kind: expected "terminal" or "accent"`);
    const file = reader.string(entry, "file", path, true);
    const pathErrors = errors.length;
    reader.path(file, `${path}.file`, true);
    const data =
      file !== undefined && errors.length === pathErrors
        ? readThemeFile(reader, file, `${path}.file`)
        : undefined;
    const themeId = reader.string(entry, "id", path);
    reader.id(themeId, `${path}.id`);
    return {
      kind: (kind ?? "terminal") as "terminal" | "accent",
      file: file ?? "",
      id: themeId,
      name: reader.string(entry, "name", path),
      data,
    };
  });

  const linkPatterns = reader
    .entries(raw, "link_patterns")
    .map(([entry, path]) => {
      reader.keys(entry, ["pattern", "url"], path);
      const pattern = reader.string(entry, "pattern", path, true) ?? "";
      let groups = 0;
      try {
        const regex = new RegExp(pattern);
        groups = (new RegExp(`${pattern}|`).exec("")?.length ?? 1) - 1;
        if (pattern && regex.test(""))
          errors.push(`${path}.pattern: matches empty text`);
      } catch {
        errors.push(`${path}.pattern: invalid regular expression`);
      }
      const url = reader.string(entry, "url", path, true) ?? "";
      if (url && !/^https?:\/\/[^/{}]/.test(url))
        errors.push(`${path}.url: expected an http(s) URL template`);
      for (const placeholder of url.match(/\{[^}]*\}?|\}/g) ?? []) {
        const group = /^\{(\d+)\}$/.exec(placeholder)?.[1];
        if (group === undefined)
          errors.push(
            `${path}.url: ${JSON.stringify(placeholder)} is not a {N} placeholder`,
          );
        else if (Number(group) > groups)
          errors.push(
            `${path}.url: {${group}} has no matching group in the pattern`,
          );
      }
      return { pattern, url };
    });

  const composerCommands = reader
    .entries(raw, "composer_commands")
    .map(([entry, path]) => {
      reader.keys(
        entry,
        ["name", "description", "arguments", "agents", "expand"],
        path,
      );
      const commandName = reader.string(entry, "name", path, true) ?? "";
      if (commandName && !/^\/[A-Za-z0-9_-]+$/.test(commandName))
        errors.push(
          `${path}.name: expected "/name" with letters, digits, "_" or "-"`,
        );
      return {
        name: commandName,
        description: reader.string(entry, "description", path),
        arguments: reader.string(entry, "arguments", path),
        agents: reader.strings(entry, "agents", path),
        expand: reader.string(entry, "expand", path),
      };
    });
  reader.unique(
    composerCommands.map((command) => command.name || undefined),
    "composer_commands",
  );

  const previewers = reader.entries(raw, "previewers").map(([entry, path]) => {
    reader.keys(entry, ["extensions", "mime_types", "frame"], path);
    const frame = reader.string(entry, "frame", path, true) ?? "";
    if (frame && !frameIds.has(frame))
      errors.push(
        `${path}.frame: ${JSON.stringify(frame)} is not declared in [[frames]]`,
      );
    const extensions = reader.strings(entry, "extensions", path);
    for (const extension of extensions ?? [])
      if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(extension))
        errors.push(
          `${path}.extensions: expected a file extension like ".csv" (got ${JSON.stringify(extension)})`,
        );
    const mimeTypes = reader.strings(entry, "mime_types", path);
    for (const mimeType of mimeTypes ?? [])
      if (
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i.test(
          mimeType,
        )
      )
        errors.push(
          `${path}.mime_types: expected a MIME type like "text/csv" (got ${JSON.stringify(mimeType)})`,
        );
    if (!extensions?.length && !mimeTypes?.length)
      errors.push(`${path}: set extensions or mime_types`);
    return { extensions, mime_types: mimeTypes, frame };
  });
  const platforms = reader.platforms(raw, "manifest");

  const result: ManifestValidation = { root, errors, warnings };
  if (errors.length > 0) return result;
  const manifest: ExtensionManifest = {
    id: id ?? "",
    name: name ?? "",
    version: version ?? "",
    api: (api ?? "").trim(),
    min_roamgate_version: minVersion,
    description: reader.string(raw, "description", "manifest"),
    author,
    homepage: reader.string(raw, "homepage", "manifest"),
    repository: reader.string(raw, "repository", "manifest"),
    license: reader.string(raw, "license", "manifest"),
    platforms,
    capabilities,
    network_hosts: networkHosts,
    mod,
    activation:
      mod === undefined ? [] : activation.length ? activation : ["startup"],
    experimental,
    start_hint: reader.string(raw, "start_hint", "manifest"),
    config,
    build,
    commands,
    keybindings,
    slots,
    hooks,
    routes,
    frames,
    themes,
    link_patterns: linkPatterns,
    composer_commands: composerCommands,
    previewers,
  };
  result.manifest = manifest;
  result.incompatible = incompatibility(manifest, options);
  return result;
}

function incompatibility(
  manifest: ExtensionManifest,
  options: ManifestValidationOptions,
): string | undefined {
  const apiVersion = options.apiVersion ?? EXTENSION_API_VERSION;
  if (!apiRangeAccepts(manifest.api, apiVersion))
    return `requires extension API ${manifest.api}; this Roamgate implements ${apiVersion}`;
  const app = versionParts(options.appVersion);
  const minimum = manifest.min_roamgate_version
    ? versionParts(manifest.min_roamgate_version)
    : null;
  if (app && minimum && compareVersions(app, minimum) < 0)
    return `requires Roamgate ${manifest.min_roamgate_version} or newer; this is ${options.appVersion}`;
  const platform = hostPlatform(options.platform);
  if (
    manifest.platforms &&
    (!platform || !manifest.platforms.includes(platform))
  )
    return `supports ${manifest.platforms.join(", ")}; this host is ${platform ?? options.platform ?? process.platform}`;
  return undefined;
}

/** Whether `url` is on a `network_hosts` entry (`host`, `*.domain`, optional `:port`). */
export function hostMatches(allowed: readonly string[], url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port;
  return allowed.some((entry) => {
    const [pattern = "", wantedPort] = entry.toLowerCase().split(/:(?=\d+$)/);
    if (wantedPort !== undefined && wantedPort !== port) return false;
    return pattern.startsWith("*.")
      ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
      : host === pattern;
  });
}

const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  "[::1]": true,
  localhost: true,
};

/** Why a url hook may not POST to `url`; null when it may. */
export function hookUrlError(
  url: string,
  networkHosts: readonly string[],
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "expected an http(s) URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return "expected an http(s) URL";
  if (parsed.username || parsed.password) return "must not carry credentials";
  if (
    !Object.hasOwn(LOOPBACK_HOSTS, parsed.hostname.toLowerCase()) &&
    !hostMatches(networkHosts, parsed)
  )
    return `${parsed.host} is neither loopback nor in network_hosts`;
  return null;
}
