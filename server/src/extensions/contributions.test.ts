import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  builtinShortcutBindings,
  normalizeShortcut,
  SHORTCUT_PLATFORM_IDS,
} from "../../../shared/shortcuts";
import {
  defaultShortcutBindings,
  normalizeShortcut as webNormalizeShortcut,
} from "../../../web/src/shortcutBindings";
import { keybindingKeyError, resolveKeybindings } from "./keybindings";
import { validateExtensionDir } from "./manifest";
import { createExtensionSandbox } from "./test-fixtures";

let sandbox = createExtensionSandbox();
afterEach(async () => {
  await sandbox.cleanup();
  sandbox = createExtensionSandbox();
});

const MANIFEST_ONLY = `
[[commands]]
id = "open"
title = "Open tracker"

[[keybindings]]
command = "open"
key = "mod+shift+u"

[[frames]]
id = "table"
entry = "./frames/table.html"

[[themes]]
kind = "terminal"
file = "./themes/dusk.json"
name = "Dusk"

[[themes]]
kind = "accent"
file = "./themes/accent.json"

[[link_patterns]]
pattern = "(PROJ)-(\\\\d+)"
url = "https://tracker.example/browse/{1}-{2}?q={0}"

[[composer_commands]]
name = "/standup"
description = "Write a standup"
agents = ["claude"]
expand = "Summarise yesterday's commits"

[[previewers]]
extensions = [".csv"]
mime_types = ["text/csv"]
frame = "table"
`;

function writeAssets(dir: string) {
  mkdirSync(join(dir, "themes"), { recursive: true });
  mkdirSync(join(dir, "frames"), { recursive: true });
  writeFileSync(
    join(dir, "themes", "dusk.json"),
    JSON.stringify({ background: "#101018", foreground: "#e0e0f0" }),
  );
  writeFileSync(
    join(dir, "themes", "accent.json"),
    JSON.stringify({ "--accent": "#ff8800" }),
  );
  writeFileSync(join(dir, "frames", "table.html"), "<table></table>");
}

function validate(id: string, body: string, assets = true) {
  const dir = sandbox.link(id, null, body);
  if (assets) writeAssets(dir);
  return validateExtensionDir(dir, { appVersion: "0.8.15" });
}

describe("manifest-only contributions", () => {
  test("a valid set validates and keeps the parsed theme files", () => {
    const result = validate("acme.tracker", MANIFEST_ONLY);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.themes).toEqual([
      {
        kind: "terminal",
        file: "./themes/dusk.json",
        id: undefined,
        name: "Dusk",
        data: { background: "#101018", foreground: "#e0e0f0" },
      },
      {
        kind: "accent",
        file: "./themes/accent.json",
        id: undefined,
        name: undefined,
        data: { "--accent": "#ff8800" },
      },
    ]);
    expect(result.manifest?.link_patterns).toEqual([
      {
        pattern: "(PROJ)-(\\d+)",
        url: "https://tracker.example/browse/{1}-{2}?q={0}",
      },
    ]);
  });

  test("theme files must exist inside the extension and hold a JSON object", () => {
    const missing = validate(
      "acme.t1",
      '[[themes]]\nkind = "terminal"\nfile = "./themes/none.json"',
    );
    expect(missing.errors).toEqual([
      'themes[0].file: "./themes/none.json" not found',
    ]);

    const outside = validate(
      "acme.t2",
      '[[themes]]\nkind = "terminal"\nfile = "./../t1/roamgate-extension.toml"',
    );
    expect(outside.errors).toEqual([
      'themes[0].file: "./../t1/roamgate-extension.toml" is outside the extension',
    ]);

    const dir = sandbox.link(
      "acme.t3",
      null,
      '[[themes]]\nkind = "terminal"\nfile = "./link.json"\n[[themes]]\nkind = "accent"\nfile = "./broken.json"\n[[themes]]\nkind = "accent"\nfile = "./list.json"',
    );
    writeFileSync(join(sandbox.root, "escape.json"), "{}");
    symlinkSync(join(sandbox.root, "escape.json"), join(dir, "link.json"));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "list.json"), "[1, 2]");
    const errors = validateExtensionDir(dir, { appVersion: "0.8.15" }).errors;
    expect(errors[0]).toBe(
      'themes[0].file: "./link.json" resolves outside the extension',
    );
    expect(errors[1]).toStartWith("themes[1].file: invalid JSON: ");
    expect(errors[2]).toBe("themes[2].file: expected a JSON object");
    expect(errors).toHaveLength(3);
  });

  test("link patterns need a compiling regex and an http(s) URL with {N} placeholders", () => {
    const patterns = [
      ['"PROJ-(\\\\d+"', '"https://t.dev/{0}"'],
      ['"x*"', '"https://t.dev/{0}"'],
      ['"PROJ-\\\\d+"', '"javascript:alert({0})"'],
      ['"PROJ-(\\\\d+)"', '"https://t.dev/{2}"'],
      ['"PROJ-\\\\d+"', '"https://t.dev/{name}"'],
      ['"PROJ-\\\\d+"', '"https://{0}/x"'],
    ]
      .map(
        ([pattern, url]) =>
          `[[link_patterns]]\npattern = ${pattern}\nurl = ${url}`,
      )
      .join("\n");
    expect(validate("acme.links", patterns).errors).toEqual([
      "link_patterns[0].pattern: invalid regular expression",
      "link_patterns[1].pattern: matches empty text",
      "link_patterns[2].url: expected an http(s) URL template",
      "link_patterns[3].url: {2} has no matching group in the pattern",
      'link_patterns[4].url: "{name}" is not a {N} placeholder',
      "link_patterns[5].url: expected an http(s) URL template",
    ]);
  });

  test("previewers name a declared frame and well-formed extensions or MIME types", () => {
    const body = `[[frames]]
id = "table"
entry = "./frames/table.html"
[[previewers]]
extensions = [".csv"]
frame = "chart"
[[previewers]]
extensions = ["csv"]
mime_types = ["text"]
frame = "table"
[[previewers]]
frame = "table"`;
    expect(validate("acme.preview", body).errors).toEqual([
      'previewers[0].frame: "chart" is not declared in [[frames]]',
      'previewers[1].extensions: expected a file extension like ".csv" (got "csv")',
      'previewers[1].mime_types: expected a MIME type like "text/csv" (got "text")',
      "previewers[2]: set extensions or mime_types",
    ]);
  });

  test("composer command names are unique", () => {
    const body = `[[composer_commands]]
name = "/standup"
[[composer_commands]]
name = "/standup"
[[composer_commands]]
name = "standup"`;
    expect(validate("acme.composer", body).errors).toEqual([
      'composer_commands[2].name: expected "/name" with letters, digits, "_" or "-"',
      'composer_commands: duplicate id "/standup"',
    ]);
  });

  test("keybinding keys follow the web app's global shortcut rules and do not repeat", () => {
    expect(keybindingKeyError("mod+shift+r")).toBeNull();
    expect(keybindingKeyError("F6")).toBeNull();
    expect(keybindingKeyError("shift+r")).toBe(
      "add ctrl, alt or mod to printable keys so typing remains available",
    );
    expect(keybindingKeyError("mod+click")).toBe(
      "keybindings use keyboard keys, not clicks",
    );
    expect(keybindingKeyError("PageUp")).toBe(
      "keybindings need a modifier or a function key",
    );
    expect(keybindingKeyError("hyper+k")).toStartWith(
      "expected a key combination",
    );
    const body = `[[commands]]
id = "a"
title = "A"
[[keybindings]]
command = "a"
key = "mod+k"
[[keybindings]]
command = "a"
key = "ctrl+k"
[[keybindings]]
command = "a"
key = "shift+k"`;
    expect(validate("acme.keys", body).errors).toEqual([
      "keybindings[1].key: Ctrl+K is already bound by keybindings[0] on windows",
      "keybindings[1].key: Ctrl+K is already bound by keybindings[0] on linux",
      "keybindings[2].key: add ctrl, alt or mod to printable keys so typing remains available",
    ]);
  });
});

describe("ext.state contributions", () => {
  test("manifest-only contributions ship in ext.state without activating anything", () => {
    const registry = sandbox.registry();
    const dir = sandbox.link("acme.tracker", null, MANIFEST_ONLY, registry);
    writeAssets(dir);
    registry.forget("acme.tracker");
    const { host } = sandbox.host(registry);
    host.start();
    const [entry] = host.state().extensions;
    expect(entry?.status).toBe("idle");
    expect(host.isRunning("acme.tracker")).toBe(false);
    expect(entry?.contributions).toMatchObject({
      frames: [{ id: "table", entry: "./frames/table.html" }],
      themes: [
        {
          kind: "terminal",
          name: "Dusk",
          data: { background: "#101018", foreground: "#e0e0f0" },
        },
        { kind: "accent", data: { "--accent": "#ff8800" } },
      ],
      link_patterns: [
        {
          pattern: "(PROJ)-(\\d+)",
          url: "https://tracker.example/browse/{1}-{2}?q={0}",
        },
      ],
      composer_commands: [
        {
          name: "/standup",
          description: "Write a standup",
          agents: ["claude"],
          expand: "Summarise yesterday's commits",
        },
      ],
      previewers: [
        { extensions: [".csv"], mime_types: ["text/csv"], frame: "table" },
      ],
      keybindings: [
        {
          command: "open",
          key: "mod+shift+u",
          keys: {
            mac: "Meta+Shift+U",
            windows: "Ctrl+Shift+U",
            linux: "Ctrl+Shift+U",
          },
          conflicts: [],
        },
      ],
    });
  });

  test("two extensions with the same keybinding: the first in order keeps it, the other is marked", () => {
    const registry = sandbox.registry();
    const binding = (command: string) => `[[commands]]
id = "${command}"
title = "${command}"
[[keybindings]]
command = "${command}"
key = "mod+shift+u"`;
    sandbox.link("acme.a", null, binding("run"), registry);
    sandbox.link("acme.b", null, binding("go"), registry);
    const { host } = sandbox.host(registry);
    host.start();
    const keybinding = (id: string) =>
      host.state().extensions.find((entry) => entry.id === id)?.contributions
        .keybindings[0];

    expect(keybinding("acme.a")?.conflicts).toEqual([]);
    expect(keybinding("acme.b")?.conflicts).toEqual([
      {
        platform: "mac",
        key: "Meta+Shift+U",
        winner: "ext:acme.a:run",
        kind: "extension",
      },
      {
        platform: "windows",
        key: "Ctrl+Shift+U",
        winner: "ext:acme.a:run",
        kind: "extension",
      },
      {
        platform: "linux",
        key: "Ctrl+Shift+U",
        winner: "ext:acme.a:run",
        kind: "extension",
      },
    ]);

    registry.setOrder(["acme.b", "acme.a"]);
    host.sync();
    expect(keybinding("acme.b")?.conflicts).toEqual([]);
    expect(
      keybinding("acme.a")?.conflicts?.map((conflict) => conflict.winner),
    ).toEqual(["ext:acme.b:go", "ext:acme.b:go", "ext:acme.b:go"]);

    // A disabled extension takes no keys; it still sees what it would lose to.
    registry.update("acme.b", { enabled: false });
    host.sync();
    expect(keybinding("acme.a")?.conflicts).toEqual([]);
  });

  test("a built-in default keeps its key, per platform", () => {
    const [resolved] = resolveKeybindings([
      { id: "acme.a", keybindings: [{ command: "side", key: "mod+b" }] },
    ]).values();
    // mod+b is Cmd+B (sidebar) on macOS and a free Ctrl+B elsewhere.
    expect(resolved?.[0]?.conflicts).toEqual([
      {
        platform: "mac",
        key: "Meta+B",
        winner: "sidebar.toggle",
        kind: "builtin",
      },
    ]);
    // Numbered command menu actions only fire inside the open menu.
    const [numbered] = resolveKeybindings([
      { id: "acme.a", keybindings: [{ command: "one", key: "alt+1" }] },
    ]).values();
    expect(numbered?.[0]?.conflicts).toEqual([]);
  });

  test("the shared built-in list mirrors the web app's defaults", () => {
    for (const platform of SHORTCUT_PLATFORM_IDS)
      expect(builtinShortcutBindings(platform)).toEqual(
        defaultShortcutBindings(platform),
      );
    for (const key of [
      "ctrl+alt+k",
      "Cmd+Shift+Enter",
      "option+arrowleft",
      "Meta+F12",
      "ctrl+backquote",
      "shift+shift+k",
      "hyper+k",
    ])
      expect(normalizeShortcut(key)).toBe(webNormalizeShortcut(key));
  });
});
