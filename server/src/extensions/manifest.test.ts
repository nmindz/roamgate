import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRangeAccepts, validateExtensionDir } from "./manifest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function extension(manifest: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-manifest-"));
  dirs.push(dir);
  const root = join(dir, "ext");
  mkdirSync(root);
  writeFileSync(join(root, "roamgate-extension.toml"), manifest);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return { dir, root };
}

const header = `
id = "acme.hello"
name = "Hello"
version = "1.2.0"
api = "^1.0"
`;
const options = { appVersion: "0.8.15", platform: "linux" };

test("a complete manifest validates with namespaced contributions and defaults", () => {
  const { root } = extension(
    `${header}
capabilities = ["ui", "commands", "process"]
network_hosts = ["api.github.com"]
mod = "./src/mod.ts"
activation = ["command:hi", "event:agent.status"]

[config.token]
type = "secret"
title = "Token"
scope = "global"

[[commands]]
id = "hi"
title = "Say hi"

[[keybindings]]
command = "hi"
key = "mod+shift+h"

[[slots]]
slot = "statusbar.item"
id = "status"
command = "hi"
when = { remote = false }

[[hooks]]
on = "pane.close"
command = ["roamgate:bun", "./hooks/guard.ts"]
timeout = 30
on_failure = "block"
`,
    { "src/mod.ts": "export function register() {}", "hooks/guard.ts": "" },
  );
  const result = validateExtensionDir(root, options);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.incompatible).toBeUndefined();
  expect(result.manifest).toMatchObject({
    id: "acme.hello",
    capabilities: ["ui", "commands", "process"],
    activation: ["command:hi", "event:agent.status"],
    commands: [{ id: "hi", title: "Say hi" }],
    slots: [{ slot: "statusbar.item", id: "status", when: { remote: false } }],
    hooks: [{ on: "pane.close", on_failure: "block" }],
    config: { token: { type: "secret", title: "Token" } },
  });
});

test("an unknown key inside a table entry is an error naming it; unknown top-level keys only warn", () => {
  const strict = validateExtensionDir(
    extension(`${header}
[[hooks]]
on = "pane.close"
command = ["sh", "-c", "exit 0"]
tiemout = 30
`).root,
    options,
  );
  expect(strict.manifest).toBeUndefined();
  expect(strict.errors).toEqual(['hooks[0]: unknown key "tiemout"']);

  const lenient = validateExtensionDir(
    extension(`${header}\nfuture_key = true\n`).root,
    options,
  );
  expect(lenient.errors).toEqual([]);
  expect(lenient.warnings).toEqual([
    'unknown top-level key "future_key" ignored',
  ]);
  expect(lenient.manifest?.id).toBe("acme.hello");
});

test("paths escaping the directory through .. or a symlink fail validation", () => {
  const { dir, root } = extension(`${header}\nmod = "./../outside.ts"\n`);
  writeFileSync(join(dir, "outside.ts"), "export function register() {}");
  const dotted = validateExtensionDir(root, options);
  expect(dotted.manifest).toBeUndefined();
  expect(dotted.errors).toEqual([
    'manifest.mod: "./../outside.ts" is outside the extension',
  ]);

  const linked = extension(
    `${header}
mod = "./mod.ts"

[[frames]]
id = "chart"
entry = "./frames/chart.html"
`,
  );
  writeFileSync(join(linked.dir, "secret.ts"), "export function register() {}");
  symlinkSync(join(linked.dir, "secret.ts"), join(linked.root, "mod.ts"));
  mkdirSync(join(linked.root, "frames"));
  symlinkSync(linked.dir, join(linked.root, "frames", "up"));
  writeFileSync(join(linked.dir, "chart.html"), "<p>");
  symlinkSync(
    join(linked.dir, "chart.html"),
    join(linked.root, "frames", "chart.html"),
  );
  const result = validateExtensionDir(linked.root, options);
  expect(result.manifest).toBeUndefined();
  expect(result.errors).toEqual([
    'manifest.mod: "./mod.ts" resolves outside the extension',
    'frames[0].entry: "./frames/chart.html" resolves outside the extension',
  ]);

  const commandEscape = validateExtensionDir(
    extension(`${header}
[[hooks]]
on = "pane.close"
command = ["sh", "../escape.sh"]
`).root,
    options,
  );
  expect(commandEscape.errors).toEqual([
    'hooks[0].command[1]: paths start with "./" (got "../escape.sh")',
  ]);
});

test("an incompatible API or Roamgate version is reported with the required version", () => {
  const future = validateExtensionDir(
    extension(header.replace('"^1.0"', '"^2.0"')).root,
    options,
  );
  expect(future.errors).toEqual([]);
  expect(future.manifest?.api).toBe("^2.0");
  expect(future.incompatible).toBe(
    "requires extension API ^2.0; this Roamgate implements 1.0",
  );
  const newer = validateExtensionDir(
    extension(`${header}\nmin_roamgate_version = "9.0.0"\n`).root,
    options,
  );
  expect(newer.incompatible).toBe(
    "requires Roamgate 9.0.0 or newer; this is 0.8.15",
  );
  const platform = validateExtensionDir(
    extension(`${header}\nplatforms = ["windows"]\n`).root,
    options,
  );
  expect(platform.incompatible).toBe("supports windows; this host is linux");
});

test("ids, capabilities, events and activation triggers are checked", () => {
  const result = validateExtensionDir(
    extension(
      `
id = "bad id"
name = "Bad"
version = "1"
api = "^1.0"
capabilities = ["root"]
mod = "./mod.ts"
activation = ["event:pane.explode", "slot:nowhere", "later", "event:rpc.call"]
`,
      { "mod.ts": "" },
    ).root,
    options,
  );
  expect(result.manifest).toBeUndefined();
  expect(result.errors).toEqual([
    'manifest.id: use 1-64 letters, digits, ".", "_" or "-" (got "bad id")',
    'manifest.version: expected SemVer (got "1")',
    'manifest.capabilities: unknown capability "root"',
    'manifest.activation[0]: unknown event "pane.explode"',
    'manifest.activation[1]: unknown slot "nowhere"',
    'manifest.activation[2]: expected "startup", "event:<name>", "command:<id>" or "slot:<slot>"',
    "manifest.activation[3]: rpc.call is experimental and needs experimental = true",
  ]);
});

test("a mod without activation triggers starts at startup", () => {
  const result = validateExtensionDir(
    extension(`${header}\nmod = "./mod.js"\n`, { "mod.js": "" }).root,
    options,
  );
  expect(result.manifest?.activation).toEqual(["startup"]);
});

test("API ranges follow caret, tilde, minimum and exact forms", () => {
  expect(apiRangeAccepts("^1.0", "1.0")).toBe(true);
  expect(apiRangeAccepts("^1.0", "1.3")).toBe(true);
  expect(apiRangeAccepts("^1.2", "1.0")).toBe(false);
  expect(apiRangeAccepts("^2.0", "1.0")).toBe(false);
  expect(apiRangeAccepts("~1.0", "1.1")).toBe(false);
  expect(apiRangeAccepts("1.0", "1.0")).toBe(true);
  expect(apiRangeAccepts(">=0.9", "1.0")).toBe(true);
  expect(apiRangeAccepts("^0.1", "0.2")).toBe(false);
});
