import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionPaths } from "../extensions/paths";
import { ExtensionRegistry } from "../extensions/registry";
import { createExtCommand } from "./ext";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli | undefined;
afterEach(() => cli?.cleanup());

function setup(running = false) {
  cli = createTestCli({ runtime: { platform: process.platform } });
  const paths = extensionPaths(join(cli.home, "data", "extensions"));
  const command = createExtCommand({
    probe: async () => running,
    confirm: async () => false,
    strictValidation: () => false,
    paths: () => paths,
  });
  const dir = (id: string, body = "") => {
    const path = join(cli!.home, "src", id);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "roamgate-extension.toml"),
      `id = "${id}"\nname = "${id}"\nversion = "1.0.0"\napi = "^1.0"\nmod = "./mod.ts"\n${body}\n`,
    );
    writeFileSync(join(path, "mod.ts"), "export function register() {}");
    return path;
  };
  const registry = () => new ExtensionRegistry({ paths, appVersion: "1.2.3" });
  return { cli, command, dir, registry, context: cli.context };
}

test("link, order and disable act on registry.json the running service follows", async () => {
  const { cli, command, dir, registry, context } = setup(true);
  expect(await command.run(["link", dir("acme.a")], context)).toBe(0);
  expect(await command.run(["link", dir("acme.b")], context)).toBe(0);
  expect(
    registry()
      .records()
      .map((record) => record.id),
  ).toEqual(["acme.a", "acme.b"]);
  expect(await command.run(["order", "acme.b", "acme.a"], context)).toBe(0);
  expect(
    registry()
      .records()
      .map((record) => record.id),
  ).toEqual(["acme.b", "acme.a"]);
  expect(cli.output.at(-1)).toBe(
    "Order: acme.b, acme.a; the running service picks it up now.",
  );
  expect(await command.run(["disable", "acme.a"], context)).toBe(0);
  expect(registry().get("acme.a")?.enabled).toBe(false);

  expect(await command.run(["list", "--json"], context)).toBe(0);
  expect(JSON.parse(cli.output.at(-1)!).extensions).toMatchObject([
    { id: "acme.b", status: "enabled" },
    { id: "acme.a", status: "disabled" },
  ]);
});

test("validate exits 2 on a capability mismatch and lists the mod's calls", async () => {
  const { cli, command, dir, context } = setup();
  const path = dir("acme.net");
  writeFileSync(
    join(path, "mod.ts"),
    `export function register(on, $) {
      on("agent.status", async ($) => { await $.http.fetch("https://x.dev"); });
    }`,
  );
  expect(await command.run(["validate", path], context)).toBe(2);
  expect(cli.output.join("\n")).toContain(
    'error: $.http.fetch needs "network", which acme.net does not declare',
  );
  expect(cli.output.join("\n")).toContain("Handles events:\n  agent.status");
});

test("a non-interactive install without --yes installs nothing", async () => {
  const { cli, command, context, registry } = setup();
  const repo = join(cli.home, "repo");
  mkdirSync(repo);
  writeFileSync(
    join(repo, "roamgate-extension.toml"),
    'id = "acme.repo"\nname = "Repo"\nversion = "1.0.0"\napi = "^1.0"\n',
  );
  const git = (...args: string[]) =>
    Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      {
        cwd: repo,
      },
    );
  git("init", "--quiet");
  git("add", "-A");
  git("commit", "--quiet", "-m", "init");
  expect(await command.run(["install", `file://${repo}`], context)).toBe(1);
  expect(registry().get("acme.repo")).toBeUndefined();
  expect(
    await command.run(["install", `file://${repo}`, "--yes"], context),
  ).toBe(0);
  expect(registry().get("acme.repo")?.source.kind).toBe("git");
}, 30_000);
