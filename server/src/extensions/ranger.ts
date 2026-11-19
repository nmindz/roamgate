import {
  type EventOrigin,
  EXTENSION_TOOL_NAME_PATTERN,
  type ExtensionEventBase,
  type ExtensionManifest,
} from "../../../shared/extensions";
import { isRecord } from "../agent/session-utils";
import type { ExtensionHost } from "./host";

/**
 * Tools extensions with the `ranger` capability give Ranger. The mod answers
 * `ranger.tools` with descriptors and `tool.<name>` with a tool's output.
 */

/** Cap on a tool's text as Ranger sees it, marker included. */
export const EXTENSION_TOOL_OUTPUT_LIMIT = 64 * 1024;
export const EXTENSION_TOOL_TRUNCATED =
  "\n[Output truncated: extension tool output is capped at 64 KiB.]";
const MAX_TOOLS = 32;
const MAX_DESCRIPTION = 2_000;
const MAX_SCHEMA_BYTES = 16 * 1024;

export type ExtensionToolSchema = {
  type: "object";
  required?: string[];
  [key: string]: unknown;
};

export interface ExtensionTool {
  ext: string;
  /** The extension's display name. */
  extName: string;
  name: string;
  description: string;
  input_schema: ExtensionToolSchema;
  /** Declared mutating or `replay: "unsafe"`: runs only as a confirmed action. */
  mutating: boolean;
}

export interface RangerToolProvider {
  /** Whether any extension may expose tools; false means `list` is empty. */
  available(): boolean;
  /** Every extension tool, asked once per extension version. */
  list(signal?: AbortSignal): Promise<ExtensionTool[]>;
  /** One tool as its extension currently declares it. */
  find(ext: string, name: string): Promise<ExtensionTool | undefined>;
  /** Runs a tool's handler; the output is untrusted text, not yet capped. */
  run(
    tool: ExtensionTool,
    input: Record<string, unknown>,
    context?: Pick<ExtensionEventBase, "connection" | "workspace_id"> & {
      origin?: EventOrigin;
      signal?: AbortSignal;
    },
  ): Promise<string>;
}

type ToolHost = Pick<ExtensionHost, "withCapability" | "answerOne">;

function parseTool(
  ext: string,
  extName: string,
  value: unknown,
): ExtensionTool | null {
  if (!isRecord(value)) return null;
  const { name, description, mutating, replay } = value;
  const schema = value.input_schema ?? { type: "object", properties: {} };
  if (
    typeof name !== "string" ||
    !EXTENSION_TOOL_NAME_PATTERN.test(name) ||
    typeof description !== "string" ||
    !description.trim() ||
    description.length > MAX_DESCRIPTION ||
    (mutating !== undefined && typeof mutating !== "boolean") ||
    (replay !== undefined && replay !== "safe" && replay !== "unsafe") ||
    !isRecord(schema) ||
    (schema.type !== undefined && schema.type !== "object") ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((key) => typeof key !== "string")))
  )
    return null;
  let copy: ExtensionToolSchema;
  try {
    const serialized = JSON.stringify({ ...schema, type: "object" });
    if (serialized.length > MAX_SCHEMA_BYTES) return null;
    copy = JSON.parse(serialized);
  } catch {
    return null;
  }
  return {
    ext,
    extName,
    name,
    description: description.trim(),
    input_schema: copy,
    mutating: mutating === true || replay === "unsafe",
  };
}

/** Valid descriptors from a `ranger.tools` answer; the rest are dropped. */
export function parseExtensionTools(
  ext: string,
  extName: string,
  value: unknown,
): ExtensionTool[] {
  if (!Array.isArray(value)) return [];
  const tools: ExtensionTool[] = [];
  for (const entry of value) {
    const tool = parseTool(ext, extName, entry);
    if (tool && !tools.some((known) => known.name === tool.name))
      tools.push(tool);
    if (tools.length >= MAX_TOOLS) break;
  }
  return tools;
}

/** Minimal schema check: an object with every required key. */
export function validateToolInput(
  schema: ExtensionToolSchema,
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!isRecord(input)) throw new Error("tool input must be an object");
  const missing = (schema.required ?? []).filter(
    (key) => !Object.hasOwn(input, key),
  );
  if (missing.length)
    throw new Error(`tool input is missing ${missing.join(", ")}`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Caps `text` at 64 KiB of UTF-8, ending with a truncation marker when cut. */
export function capToolOutput(text: string): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= EXTENSION_TOOL_OUTPUT_LIMIT) return text;
  const keep =
    EXTENSION_TOOL_OUTPUT_LIMIT -
    encoder.encode(EXTENSION_TOOL_TRUNCATED).length;
  // A cut multi-byte character decodes to U+FFFD; drop it.
  const head = decoder.decode(bytes.subarray(0, keep)).replace(/\uFFFD$/, "");
  return `${head}${EXTENSION_TOOL_TRUNCATED}`;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "(no output)";
  return JSON.stringify(value);
}

function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(signal.reason ?? new Error("aborted"));
  signal.addEventListener("abort", abort, { once: true });
  work.then(resolve, reject).finally(() => {
    signal.removeEventListener("abort", abort);
  });
  return promise;
}

export function createRangerToolProvider(host: ToolHost): RangerToolProvider {
  // Keyed by manifest object: a reload or update replaces it.
  const cache = new WeakMap<ExtensionManifest, ExtensionTool[]>();

  async function toolsOf(
    id: string,
    manifest: ExtensionManifest,
  ): Promise<ExtensionTool[]> {
    const cached = cache.get(manifest);
    if (cached) return cached;
    const outcome = await host.answerOne(id, {
      name: "ranger.tools",
      at: Date.now(),
      origin: "ranger",
    });
    // A failed answer is not cached, so the next turn asks again.
    if ("error" in outcome) return [];
    const tools = parseExtensionTools(id, manifest.name, outcome.value);
    cache.set(manifest, tools);
    return tools;
  }

  return {
    available: () => host.withCapability("ranger").length > 0,
    async list(signal) {
      const lists = await untilAborted(
        Promise.all(
          host
            .withCapability("ranger")
            .map(({ id, manifest }) =>
              toolsOf(id, manifest).catch((): ExtensionTool[] => []),
            ),
        ),
        signal,
      );
      return lists.flat();
    },
    async find(ext, name) {
      const entry = host
        .withCapability("ranger")
        .find((candidate) => candidate.id === ext);
      if (!entry) return undefined;
      return (await toolsOf(entry.id, entry.manifest)).find(
        (tool) => tool.name === name,
      );
    },
    async run(tool, input, context = {}) {
      const { signal, origin, ...scope } = context;
      const outcome = await untilAborted(
        host.answerOne(tool.ext, {
          ...scope,
          name: `tool.${tool.name}`,
          at: Date.now(),
          origin: origin ?? "ranger",
          input,
        }),
        signal,
      );
      if ("error" in outcome) throw new Error(outcome.error);
      return outputText(outcome.value);
    },
  };
}

let installed: RangerToolProvider | null = null;

/** The provider Ranger turns and confirmed extension-tool actions use. */
export function installRangerTools(provider: RangerToolProvider): () => void {
  installed = provider;
  return () => {
    if (installed === provider) installed = null;
  };
}

export function rangerToolProvider(): RangerToolProvider | null {
  return installed;
}
