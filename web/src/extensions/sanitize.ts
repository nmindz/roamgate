import {
  ELEMENT_LIMITS,
  type El,
  type ElementTone,
} from "../../../shared/extensions";

export class ElementTreeError extends Error {}

const TONES: readonly ElementTone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
];

/** Documented props per element; anything else is dropped (and logged in dev). */
export const ELEMENT_PROPS: Readonly<Record<string, readonly string[]>> = {
  Stack: ["id", "gap", "children"],
  Row: ["id", "gap", "children"],
  Text: ["text", "tone", "weight", "mono"],
  Markdown: ["md"],
  Code: ["code", "lang"],
  Badge: ["text", "tone"],
  Icon: ["name"],
  Button: ["id", "label", "icon", "tone", "command", "disabled"],
  Link: ["href", "label"],
  Input: ["id", "value", "placeholder"],
  TextArea: ["id", "value", "placeholder"],
  Select: ["id", "value", "options"],
  Toggle: ["id", "value", "label"],
  Progress: ["value"],
  Spinner: [],
  List: ["items"],
  Table: ["columns", "rows"],
  KeyValue: ["items"],
  Divider: [],
  Image: ["src", "alt"],
  Empty: ["title", "body"],
  Frame: ["frame", "height"],
};

export interface SanitizedTree {
  tree: El;
  /** `Element.prop` pairs that were dropped for not being documented. */
  dropped: string[];
}

const str = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
const tone = (value: unknown): ElementTone | undefined =>
  TONES.includes(value as ElementTone) ? (value as ElementTone) : undefined;
const bool = (value: unknown) => (value === true ? true : undefined);

/** Validates a tree against CONTRACT §4: vocabulary, props, depth, nodes, bytes. */
export function sanitizeTree(value: unknown): SanitizedTree {
  const bytes = new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  if (bytes > ELEMENT_LIMITS.bytes)
    throw new ElementTreeError(
      `Element tree is ${bytes} bytes; the limit is ${ELEMENT_LIMITS.bytes}`,
    );
  const dropped: string[] = [];
  let nodes = 0;

  const build = (node: unknown, depth: number): El => {
    if (depth > ELEMENT_LIMITS.depth)
      throw new ElementTreeError(
        `Element tree is deeper than ${ELEMENT_LIMITS.depth} levels`,
      );
    if (++nodes > ELEMENT_LIMITS.nodes)
      throw new ElementTreeError(
        `Element tree has more than ${ELEMENT_LIMITS.nodes} nodes`,
      );
    if (!node || typeof node !== "object" || Array.isArray(node))
      throw new ElementTreeError("Element is not an object");
    const raw = node as Record<string, unknown>;
    const type = raw.t;
    const allowed = typeof type === "string" ? ELEMENT_PROPS[type] : undefined;
    if (!allowed)
      throw new ElementTreeError(`Unknown element "${String(type)}"`);
    for (const key of Object.keys(raw))
      if (key !== "t" && !allowed.includes(key)) dropped.push(`${type}.${key}`);
    const children = (field: unknown): El[] => {
      if (!Array.isArray(field))
        throw new ElementTreeError(`${type} needs a list of elements`);
      return field.map((child) => build(child, depth + 1));
    };
    switch (type) {
      case "Stack":
      case "Row":
        return {
          t: type,
          ...(typeof raw.id === "string" ? { id: raw.id } : {}),
          ...(raw.gap === 0 || raw.gap === 1 || raw.gap === 2 || raw.gap === 3
            ? { gap: raw.gap }
            : {}),
          children: children(raw.children ?? []),
        };
      case "Text":
        return {
          t: "Text",
          text: str(raw.text),
          tone: tone(raw.tone),
          weight: raw.weight === "strong" ? "strong" : undefined,
          mono: bool(raw.mono),
        };
      case "Markdown":
        return { t: "Markdown", md: str(raw.md) };
      case "Code":
        return {
          t: "Code",
          code: str(raw.code),
          lang: str(raw.lang) || undefined,
        };
      case "Badge":
        return { t: "Badge", text: str(raw.text), tone: tone(raw.tone) };
      case "Icon":
        return { t: "Icon", name: str(raw.name) };
      case "Button":
        return {
          t: "Button",
          id: str(raw.id),
          label: str(raw.label),
          icon: str(raw.icon) || undefined,
          tone: tone(raw.tone),
          command: str(raw.command) || undefined,
          disabled: bool(raw.disabled),
        };
      case "Link":
        return { t: "Link", href: str(raw.href), label: str(raw.label) };
      case "Input":
      case "TextArea":
        return {
          t: type,
          id: str(raw.id),
          value: str(raw.value),
          placeholder: str(raw.placeholder) || undefined,
        };
      case "Select": {
        const options = Array.isArray(raw.options) ? raw.options : [];
        return {
          t: "Select",
          id: str(raw.id),
          value: str(raw.value),
          options: options.flatMap((option) =>
            option && typeof option === "object"
              ? [
                  {
                    value: str((option as { value?: unknown }).value),
                    label: str((option as { label?: unknown }).label),
                  },
                ]
              : [],
          ),
        };
      }
      case "Toggle":
        return {
          t: "Toggle",
          id: str(raw.id),
          value: raw.value === true,
          label: str(raw.label),
        };
      case "Progress":
        return {
          t: "Progress",
          ...(typeof raw.value === "number" && Number.isFinite(raw.value)
            ? { value: Math.min(1, Math.max(0, raw.value)) }
            : {}),
        };
      case "Spinner":
        return { t: "Spinner" };
      case "List":
        return { t: "List", items: children(raw.items ?? []) };
      case "Table": {
        const rows = Array.isArray(raw.rows) ? raw.rows : [];
        return {
          t: "Table",
          columns: Array.isArray(raw.columns) ? raw.columns.map(String) : [],
          rows: rows.map((row) => children(row)),
        };
      }
      case "KeyValue": {
        const items = Array.isArray(raw.items) ? raw.items : [];
        return {
          t: "KeyValue",
          items: items.map((item) => {
            const entry = (item ?? {}) as { k?: unknown; v?: unknown };
            return { k: str(entry.k), v: build(entry.v, depth + 1) };
          }),
        };
      }
      case "Divider":
        return { t: "Divider" };
      case "Image":
        return { t: "Image", src: str(raw.src), alt: str(raw.alt) };
      case "Empty":
        return {
          t: "Empty",
          title: str(raw.title),
          body: str(raw.body) || undefined,
        };
      default:
        return {
          t: "Frame",
          frame: str(raw.frame),
          ...(typeof raw.height === "number" ? { height: raw.height } : {}),
        };
    }
  };

  const tree = build(value, 1);
  if (import.meta.env?.DEV && dropped.length > 0)
    console.warn(`Extension element props dropped: ${dropped.join(", ")}`);
  return { tree, dropped };
}

export function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const INLINE_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

/** Inline raster data or a same-origin path inside the extension's own routes. */
export function isSafeImageSrc(src: string, ext: string): boolean {
  return (
    INLINE_IMAGE.test(src) ||
    (src.startsWith(`/ext/${ext}/`) && !src.split(/[?#]/)[0].includes(".."))
  );
}
