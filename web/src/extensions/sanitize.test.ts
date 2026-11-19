import { describe, expect, test } from "bun:test";
import { ELEMENT_LIMITS, type El } from "../../../shared/extensions";
import {
  ElementTreeError,
  isSafeHref,
  isSafeImageSrc,
  sanitizeTree,
} from "./sanitize";

const text = (value: string): El => ({ t: "Text", text: value });

function nested(depth: number): El {
  let tree: El = text("leaf");
  for (let level = 1; level < depth; level++)
    tree = { t: "Stack", children: [tree] };
  return tree;
}

describe("sanitizeTree limits", () => {
  test("accepts exactly the depth limit and rejects one level more", () => {
    expect(() => sanitizeTree(nested(ELEMENT_LIMITS.depth))).not.toThrow();
    expect(() => sanitizeTree(nested(ELEMENT_LIMITS.depth + 1))).toThrow(
      ElementTreeError,
    );
  });

  test("accepts exactly the node limit and rejects one node more", () => {
    const stack = (count: number): El => ({
      t: "Stack",
      children: Array.from({ length: count - 1 }, () => text("")),
    });
    expect(() => sanitizeTree(stack(ELEMENT_LIMITS.nodes))).not.toThrow();
    expect(() => sanitizeTree(stack(ELEMENT_LIMITS.nodes + 1))).toThrow(
      /more than 2000 nodes/,
    );
  });

  test("rejects a tree over the serialized byte limit", () => {
    const big = text("x".repeat(ELEMENT_LIMITS.bytes));
    expect(() => sanitizeTree(big)).toThrow(/bytes; the limit is/);
  });

  test("rejects unknown elements, non-objects and malformed children", () => {
    expect(() => sanitizeTree({ t: "Script", src: "x" })).toThrow(
      /Unknown element "Script"/,
    );
    expect(() => sanitizeTree("Text")).toThrow(ElementTreeError);
    expect(() => sanitizeTree(null)).toThrow(ElementTreeError);
    expect(() => sanitizeTree({ t: "Stack", children: "no" })).toThrow(
      /list of elements/,
    );
    expect(() => sanitizeTree({ t: "Stack", children: [3] })).toThrow(
      /not an object/,
    );
  });
});

describe("sanitizeTree props", () => {
  test("drops undocumented props and reports them", () => {
    const { tree, dropped } = sanitizeTree({
      t: "Text",
      text: "hi",
      onclick: "alert(1)",
      style: "color:red",
      tone: "danger",
    });
    expect(tree).toEqual({
      t: "Text",
      text: "hi",
      tone: "danger",
      weight: undefined,
      mono: undefined,
    });
    expect(dropped).toEqual(["Text.onclick", "Text.style"]);
  });

  test("coerces wrong-typed props to safe defaults", () => {
    const { tree } = sanitizeTree({
      t: "Button",
      id: 5,
      label: { x: 1 },
      tone: "rainbow",
      disabled: "yes",
    });
    expect(tree).toMatchObject({
      t: "Button",
      id: "",
      label: "",
      tone: undefined,
      disabled: undefined,
    });
  });

  test("keeps the whole vocabulary", () => {
    const names = [
      "Stack",
      "Row",
      "Text",
      "Markdown",
      "Code",
      "Badge",
      "Icon",
      "Button",
      "Link",
      "Input",
      "TextArea",
      "Select",
      "Toggle",
      "Progress",
      "Spinner",
      "List",
      "Table",
      "KeyValue",
      "Divider",
      "Image",
      "Empty",
      "Frame",
    ];
    for (const name of names) {
      const { tree } = sanitizeTree({
        t: name,
        children: [],
        items: [],
        columns: [],
        rows: [],
        options: [],
      });
      expect(tree.t).toBe(name as El["t"]);
    }
  });

  test("clamps progress and nests table cells and key-value elements", () => {
    expect(sanitizeTree({ t: "Progress", value: 4 }).tree).toEqual({
      t: "Progress",
      value: 1,
    });
    const { tree } = sanitizeTree({
      t: "Table",
      columns: ["a"],
      rows: [[{ t: "Text", text: "cell" }]],
    });
    expect(tree).toMatchObject({ t: "Table", rows: [[{ t: "Text" }]] });
    expect(
      sanitizeTree({
        t: "KeyValue",
        items: [{ k: "k", v: { t: "Badge", text: "b" } }],
      }).tree,
    ).toMatchObject({ items: [{ k: "k", v: { t: "Badge", text: "b" } }] });
  });
});

describe("URL safety", () => {
  test("links are http(s) only", () => {
    expect(isSafeHref("https://example.com/a")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,x")).toBe(false);
    expect(isSafeHref("/relative")).toBe(false);
  });

  test("images are inline raster data or the extension's own routes", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA", "a.b")).toBe(true);
    expect(isSafeImageSrc("data:image/svg+xml;base64,AAAA", "a.b")).toBe(false);
    expect(isSafeImageSrc("https://evil.example/x.png", "a.b")).toBe(false);
    expect(isSafeImageSrc("/ext/a.b/frame/logo.png", "a.b")).toBe(true);
    expect(isSafeImageSrc("/ext/other/frame/logo.png", "a.b")).toBe(false);
    expect(isSafeImageSrc("/ext/a.b/../x.png", "a.b")).toBe(false);
  });
});
