import { readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import {
  API_STABILITY,
  type ExtensionApiStability,
  type ExtensionCapability,
  type ExtensionManifest,
  eventStability,
  isExtensionEvent,
  isToolEvent,
  methodStability,
} from "../../../shared/extensions";
import { assertDollarCallAllowed } from "./guard";
import { type StabilityIssue, stabilityIssue } from "./manifest";

/**
 * What a mod does, read from its source without running it: the events it
 * registers for, the `$` calls it makes and its direct runtime imports. Call
 * sites with computed names are reported as unreadable.
 */
export interface ModAnalysis {
  /** Scanned source files, relative to the extension directory. */
  files: string[];
  events: string[];
  /** `ns.method` for each `$.ns.method(...)` call site. */
  calls: string[];
  /** `node:*`, `bun:*` and `Bun.*` the mod reaches directly. */
  imports: string[];
  /** Call sites static analysis cannot read, with where they are. */
  unreadable: string[];
  /** Calls needing a capability the manifest does not declare. */
  mismatches: Array<{ call: string; needs: ExtensionCapability[] }>;
  errors: string[];
  /** Deprecated API uses; `ext validate` prints them as warnings. */
  warnings?: string[];
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

/**
 * Capabilities a `$` call needs: every inner list must have one declared.
 * Namespaces missing here need none.
 */
const NAMESPACE_CAPABILITIES: Readonly<
  Record<string, ExtensionCapability[][]>
> = {
  ui: [["ui"]],
  command: [["commands"]],
  roamgate: [["workspace.read"]],
  herdr: [["herdr.read", "herdr.write"]],
  terminal: [["terminal.write"]],
  agent: [["agent.sessions"]],
  notify: [["notifications"]],
  process: [["process", "process.remote"]],
  http: [["network"]],
  files: [["files.read", "files.write"]],
  routes: [["http.routes"]],
  ranger: [["ranger"]],
};
const CALL_CAPABILITIES: Readonly<Record<string, ExtensionCapability[][]>> = {
  "ui.ask": [["gates"]],
  "terminal.screen": [["terminal.read"]],
  "files.read": [["files.read"]],
  "files.write": [["files.write"]],
};
const FREE_NAMESPACES = new Set([
  "store",
  "state",
  "clock",
  "events",
  "log",
  "config",
]);

function escape(name: string): string {
  return name.replace(/[$]/g, "\\$");
}

function loaderFor(file: string): "ts" | "tsx" | "js" | "jsx" {
  const extension = extname(file);
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if (extension === ".js" || extension === ".mjs") return "js";
  return "ts";
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

/** A relative import's file inside the extension, or null. */
function resolveLocal(root: string, from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${sep}index${extension}`),
  ];
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      const real = realpathSync(candidate);
      return inside(root, real) ? real : null;
    } catch {}
  }
  return null;
}

/** Capabilities a call needs that `declared` lacks, or null when satisfied. */
export function missingCapabilities(
  call: string,
  declared: readonly string[],
): ExtensionCapability[] | null {
  const ns = call.slice(0, call.indexOf("."));
  const needs = CALL_CAPABILITIES[call] ?? NAMESPACE_CAPABILITIES[ns] ?? [];
  const missing = needs.find((options) =>
    options.every((capability) => !declared.includes(capability)),
  );
  return missing ?? null;
}

/** Statically analyzes the mod of the extension rooted at `root`. */
export function analyzeExtension(
  root: string,
  manifest: ExtensionManifest,
  stability: ExtensionApiStability = API_STABILITY,
): ModAnalysis {
  const analysis: ModAnalysis = {
    files: [],
    events: [],
    calls: [],
    imports: [],
    unreadable: [],
    mismatches: [],
    errors: [],
  };
  if (!manifest.mod) return analysis;
  const realRoot = realpathSync(root);
  const events = new Set<string>();
  const calls = new Set<string>();
  const imports = new Set<string>();
  const queue = [realpathSync(resolve(realRoot, manifest.mod))];
  const seen = new Set<string>();
  // Names the mod gives `on` and `$`; handlers usually keep `$`.
  let onName = "on";
  const dollarNames = new Set(["$"]);

  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const where = relative(realRoot, file);
    if (seen.size > MAX_FILES) {
      analysis.unreadable.push(
        `more than ${MAX_FILES} source files; the rest was not read`,
      );
      break;
    }
    let source: string;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) {
        analysis.unreadable.push(`${where}: larger than 4 MiB, not read`);
        continue;
      }
      source = readFileSync(file, "utf8");
    } catch (error) {
      analysis.errors.push(`${where}: ${(error as Error).message}`);
      continue;
    }
    analysis.files.push(where);
    let code: string;
    try {
      const transpiler = new Bun.Transpiler({ loader: loaderFor(file) });
      for (const { path } of transpiler.scan(source).imports) {
        if (path.startsWith(".")) {
          const local = resolveLocal(realRoot, file, path);
          if (local) queue.push(local);
          else
            analysis.errors.push(
              `${where}: import ${JSON.stringify(path)} is not a file inside the extension`,
            );
        } else if (path === "bun" || path.startsWith("bun:")) imports.add(path);
        else if (path.startsWith("node:") || isBuiltin(path))
          imports.add(path.startsWith("node:") ? path : `node:${path}`);
      }
      code = transpiler.transformSync(source);
    } catch (error) {
      analysis.errors.push(`${where}: ${(error as Error).message}`);
      continue;
    }
    if (/\b(?:import|require)\s*\(\s*[^'"`\s)]/.test(code))
      analysis.unreadable.push(`${where}: dynamic import with a computed path`);

    const register =
      /\bregister\s*(?:=\s*(?:async\s*)?)?(?:function\s*)?\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*))?/.exec(
        code,
      );
    if (register?.[1]) onName = register[1];
    if (register?.[2]) dollarNames.add(register[2]);
    // A handler may rename `$` (`($api, e) =>`); arrow params starting with `$` count as it.
    for (const match of code.matchAll(
      /\(\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?\)\s*=>/g,
    ))
      if (match[1]?.startsWith("$")) dollarNames.add(match[1]);

    const on = escape(onName);
    for (const match of code.matchAll(
      new RegExp(
        `(?<![\\w$.])${on}\\s*\\(\\s*(?:(['"\`])((?:(?!\\1).)*)\\1|([^\\s)]))`,
        "g",
      ),
    )) {
      const literal = match[2];
      if (match[3] !== undefined || literal?.includes("${"))
        analysis.unreadable.push(
          `${where}: ${onName}(...) with an event name that is not a literal`,
        );
      else if (literal !== undefined) events.add(literal);
    }
    for (const dollar of dollarNames) {
      const name = escape(dollar);
      for (const match of code.matchAll(
        new RegExp(
          `(?<![\\w$.])${name}\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(`,
          "g",
        ),
      ))
        calls.add(`${match[1]}.${match[2]}`);
      if (new RegExp(`(?<![\\w$.])${name}\\s*(?:\\?\\.)?\\[`).test(code))
        analysis.unreadable.push(
          `${where}: ${dollar}[...] computed access to the $ API`,
        );
      for (const match of code.matchAll(
        new RegExp(
          `(?<![\\w$.])${name}\\s*\\.\\s*([A-Za-z_]\\w*)\\s*(?:\\?\\.)?(?:\\[|(?![\\s.\\w(]))`,
          "g",
        ),
      ))
        if (!FREE_NAMESPACES.has(match[1]!))
          analysis.unreadable.push(
            `${where}: ${dollar}.${match[1]} is used without a literal method call`,
          );
    }
    for (const match of code.matchAll(/(?<![\w$.])Bun\s*\.\s*([A-Za-z_]\w*)/g))
      imports.add(`Bun.${match[1]}`);
  }

  const warnings: string[] = [];
  const report = (issue: StabilityIssue | null) => {
    if (issue)
      (issue.level === "error" ? analysis.errors : warnings).push(
        issue.message,
      );
  };
  for (const event of events) {
    if (!isExtensionEvent(event) && !isToolEvent(event))
      analysis.errors.push(
        `registers for unknown event ${JSON.stringify(event)}`,
      );
    else
      report(
        stabilityIssue(
          event,
          eventStability(event, stability),
          manifest.experimental,
        ),
      );
  }
  for (const call of calls) {
    const [ns = "", method = ""] = call.split(".");
    try {
      assertDollarCallAllowed(ns, method);
    } catch (error) {
      analysis.errors.push(`$.${call}: ${(error as Error).message}`);
      continue;
    }
    report(
      stabilityIssue(
        `$.${call}`,
        methodStability(call, stability),
        manifest.experimental,
      ),
    );
    const missing = missingCapabilities(call, manifest.capabilities);
    if (missing) analysis.mismatches.push({ call, needs: missing });
  }
  analysis.warnings = warnings;
  analysis.events = [...events].sort();
  analysis.calls = [...calls].sort();
  analysis.imports = [...imports].sort();
  analysis.unreadable = [...new Set(analysis.unreadable)];
  return analysis;
}

/** One line per capability mismatch, for validate and consent. */
export function describeMismatch(
  ext: string,
  mismatch: ModAnalysis["mismatches"][number],
): string {
  return `$.${mismatch.call} needs ${mismatch.needs
    .map((capability) => `"${capability}"`)
    .join(" or ")}, which ${ext} does not declare`;
}
