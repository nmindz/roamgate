import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENSION_RPC_ERRORS } from "../../../shared/extensions";
import { silentLogger } from "../utils/logger";
import { analyzeExtension } from "./analyze";
import {
  consentDiff,
  consentRecord,
  consentSummary,
  formatConsent,
} from "./consent";
import { createDollarDispatcher } from "./dollar";
import { ExtensionBus } from "./events";
import { ExtensionInstaller, parseInstallSource } from "./install";
import { validateExtensionDir } from "./manifest";
import { ExtensionStore } from "./store";
import { createExtensionSandbox } from "./test-fixtures";

let sandbox = createExtensionSandbox();
afterEach(async () => {
  await sandbox.cleanup();
  sandbox = createExtensionSandbox();
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/** A git repository holding one extension; returns its file:// URL and writer. */
function extensionRepo(id: string) {
  const dir = join(sandbox.root, "repos", id);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
  const commit = (manifest: string, mod: string) => {
    writeFileSync(
      join(dir, "roamgate-extension.toml"),
      `id = ${JSON.stringify(id)}\nname = "Repo"\napi = "^1.0"\nmod = "./mod.ts"\n${manifest}\n`,
    );
    writeFileSync(join(dir, "mod.ts"), mod);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "update");
    return git(dir, "rev-parse", "HEAD");
  };
  return { url: pathToFileURL(dir).href, commit };
}

function installer(registry = sandbox.registry()) {
  return {
    registry,
    installer: new ExtensionInstaller({
      paths: sandbox.paths,
      registry,
      appVersion: "0.8.15",
    }),
  };
}

const guardMod = `export function register(on, $) {
  on("pane.close", async ($, e) => {
    const res = await $.http.fetch("https://example.com/policy");
    return res.ok ? { decision: "allow" } : { decision: "deny", reason: "no policy" };
  });
  on("agent.status", async ($, e) => { await $.ui.toast({ message: e.to }); });
}`;

test("validate lists events, $ calls and hook argv, and reports a capability mismatch that also fails at runtime", async () => {
  const dir = sandbox.link(
    "acme.guard",
    guardMod,
    `capabilities = ["ui", "gates"]
[[hooks]]
on = "pane.close"
command = ["roamgate:bun", "./hooks/guard.ts"]`,
  );
  mkdirSync(join(dir, "hooks"));
  writeFileSync(join(dir, "hooks/guard.ts"), "");
  const validation = validateExtensionDir(dir, { appVersion: "0.8.15" });
  const analysis = analyzeExtension(validation.root, validation.manifest!);
  expect(analysis.events).toEqual(["agent.status", "pane.close"]);
  expect(analysis.calls).toEqual(["http.fetch", "ui.toast"]);
  expect(analysis.unreadable).toEqual([]);
  expect(analysis.mismatches).toEqual([
    { call: "http.fetch", needs: ["network"] },
  ]);
  const summary = consentSummary({
    manifest: validation.manifest!,
    analysis,
    source: { kind: "link", location: dir },
  });
  expect(summary.gates).toEqual(["pane.close"]);
  expect(summary.hooks).toEqual([
    { on: "pane.close", command: ["roamgate:bun", "./hooks/guard.ts"] },
  ]);
  const text = formatConsent(summary);
  expect(text).toContain('pane.close: ["roamgate:bun","./hooks/guard.ts"]');
  expect(text).toContain(
    '$.http.fetch needs "network", which acme.guard does not declare',
  );

  const dollar = createDollarDispatcher({
    ext: "acme.guard",
    manifest: validation.manifest!,
    store: new ExtensionStore(sandbox.paths, "acme.guard"),
    root: dir,
    host: {
      lease: () => null,
      connections: () => [],
      notify: () => undefined,
      toast: () => undefined,
      invalidate: () => undefined,
      bus: new ExtensionBus(silentLogger),
    },
  });
  await expect(
    dollar.call("http", "fetch", ["https://example.com/policy"]),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.capability });
});

test("computed event names and $ access are unreadable", () => {
  const dir = sandbox.link(
    "acme.sneaky",
    `export function register(on, $) {
      const name = "pane" + ".close";
      on(name, () => undefined);
      const ns = "http";
      $[ns].fetch("x");
      const ui = $.ui;
    }`,
  );
  const validation = validateExtensionDir(dir, { appVersion: "0.8.15" });
  const analysis = analyzeExtension(validation.root, validation.manifest!);
  expect(analysis.unreadable).toEqual([
    "mod.ts: on(...) with an event name that is not a literal",
    "mod.ts: $[...] computed access to the $ API",
    "mod.ts: $.ui is used without a literal method call",
  ]);
});

test("strict validation refuses an unreadable mod", async () => {
  const dir = sandbox.link(
    "acme.strict",
    "export function register(on) { on(String(1), () => {}); }",
  );
  const registry = sandbox.registry();
  const strict = new ExtensionInstaller({
    paths: sandbox.paths,
    registry,
    appVersion: "0.8.15",
    strictValidation: () => true,
  });
  await expect(strict.link(dir)).rejects.toThrow("strict validation refuses");
});

test("the update diff lists an added route and a removed hook", () => {
  const manifest = (body: string) => {
    const dir = sandbox.link(`acme.v${body.length}`, null, body);
    return validateExtensionDir(dir, { appVersion: "0.8.15" }).manifest!;
  };
  const empty = {
    files: [],
    events: [],
    calls: [],
    imports: [],
    unreadable: [],
    mismatches: [],
    errors: [],
  };
  const source = { kind: "git" as const, location: "x" };
  const before = consentSummary({
    manifest: manifest('[[hooks]]\non = "pane.close"\ncommand = ["true"]'),
    analysis: empty,
    source,
  });
  const after = consentSummary({
    manifest: manifest('[[routes]]\nkind = "webhook"\nname = "permission"'),
    analysis: empty,
    source,
  });
  const diff = consentDiff(consentRecord(before), after);
  expect(diff.routes).toEqual({ added: ["webhook permission"], removed: [] });
  expect(diff.hooks).toEqual({
    added: [],
    removed: ['pane.close ["true"]'],
  });
  const text = formatConsent(after, diff);
  expect(text).toContain("+ routes: webhook permission");
  expect(text).toContain('- hooks: pane.close ["true"]');
});

test("sources: GitHub shorthand, git URLs, pinned archives; local directories are linked", () => {
  expect(parseInstallSource("acme/tools/ext/ci")).toEqual({
    kind: "github",
    location: "acme/tools/ext/ci",
    url: "https://github.com/acme/tools.git",
    subdir: "ext/ci",
  });
  expect(parseInstallSource("git@host:acme/x.git").kind).toBe("git");
  expect(() => parseInstallSource("https://example.com/x.tar.gz")).toThrow(
    "--sha256",
  );
  expect(() => parseInstallSource(sandbox.root)).toThrow("roamgate ext link");
});

test("the build runs once in the new version directory after consent; a timed-out build keeps the previous version", async () => {
  const repo = extensionRepo("acme.built");
  repo.commit(
    `version = "1.0.0"
[[build]]
command = ["sh", "-c", "pwd > built.txt; echo building"]`,
    "export function register() {}",
  );
  const { registry, installer: inst } = installer();
  const first = await inst.prepare(repo.url);
  expect(first.summary.build).toEqual([
    { command: ["sh", "-c", "pwd > built.txt; echo building"] },
  ]);
  const installed = await inst.apply(first);
  expect(readFileSync(join(installed.path, "built.txt"), "utf8").trim()).toBe(
    realpathSync(installed.path),
  );
  expect(existsSync(join(installed.path, ".git"))).toBe(false);
  const log = readFileSync(inst.buildLogPath("acme.built"), "utf8");
  expect(log.match(/^building$/gm)).toHaveLength(1);

  repo.commit(
    `version = "1.1.0"
[[build]]
command = ["sh", "-c", "sleep 5"]
timeout = 1`,
    "export function register() {}",
  );
  const slow = await inst.prepareUpdate("acme.built");
  await expect(inst.apply(slow!)).rejects.toThrow(
    "the previous version stays active",
  );
  expect(registry.get("acme.built")?.version).toBe("1.0.0");
  expect(registry.get("acme.built")?.path).toBe(installed.path);

  // A link never builds.
  const dir = sandbox.link(
    "acme.linked",
    null,
    '[[build]]\ncommand = ["sh", "-c", "touch built.txt"]',
  );
  await inst.link(dir);
  expect(existsSync(join(dir, "built.txt"))).toBe(false);
}, 30_000);

test("an update that adds process waits for consent, then replaces the old version once its handlers drain", async () => {
  const repo = extensionRepo("acme.upd");
  // The old handler holds its call open until the test has updated.
  const slowCommand = `export function register(on) {
    on("command.run", async ($) => {
      await $.store.set("seen", ((await $.store.get("seen")) ?? 0) + 1);
      await $.ui.toast({ message: "started" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return "old";
    });
  }`;
  repo.commit(
    'version = "1.0.0"\ncapabilities = ["ui"]\n[[commands]]\nid = "go"\ntitle = "Go"',
    slowCommand,
  );
  const { registry, installer: inst } = installer();
  const old = { ...(await inst.apply(await inst.prepare(repo.url))) };
  const retired = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { host } = sandbox.host(registry, {
    onRetired: (id) => {
      inst.prune(id);
      retired.resolve();
    },
    dollar: { toast: () => started.resolve() },
  });
  host.start();
  repo.commit(
    'version = "2.0.0"\ncapabilities = ["ui", "process"]\n[[commands]]\nid = "go"\ntitle = "Go"',
    `export function register(on) {
      on("command.run", async ($) => ((await $.store.get("seen")) ?? 0) + ":new");
    }`,
  );
  const update = await inst.prepareUpdate("acme.upd");
  expect(update?.diff?.capabilities).toEqual({
    added: ["process"],
    removed: [],
  });
  // Without consent nothing changes.
  expect(registry.get("acme.upd")?.path).toBe(old.path);

  const running = host.runCommand("acme.upd", "go");
  await started.promise;
  const updated = await inst.apply(update!);
  host.sync();
  expect(existsSync(old.path)).toBe(true);
  expect(await running).toBe("old");
  await retired.promise;
  expect(existsSync(old.path)).toBe(false);
  expect(existsSync(updated.path)).toBe(true);
  expect(await host.runCommand("acme.upd", "go")).toBe("1:new");
}, 30_000);

test("uninstall removes the data directory unless asked to keep it", async () => {
  const repo = extensionRepo("acme.data");
  repo.commit('version = "1.0.0"', "export function register() {}");
  const { registry, installer: inst } = installer();
  const record = await inst.apply(await inst.prepare(repo.url));
  new ExtensionStore(sandbox.paths, "acme.data").set("k", 1);
  inst.uninstall("acme.data", { keepData: true, prune: true });
  expect(existsSync(sandbox.paths.storeFile("acme.data"))).toBe(true);
  expect(existsSync(record.path)).toBe(false);

  await inst.apply(await inst.prepare(repo.url));
  expect(new ExtensionStore(sandbox.paths, "acme.data").get("k")).toBe(1);
  inst.uninstall("acme.data", { prune: true });
  expect(existsSync(sandbox.paths.dataDir("acme.data"))).toBe(false);
  expect(registry.get("acme.data")).toBeUndefined();
}, 30_000);
