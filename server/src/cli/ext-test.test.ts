import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionPaths } from "../extensions/paths";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./command";
import { createExtCommand } from "./ext";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli | undefined;
afterEach(() => cli?.cleanup());

const examples = join(import.meta.dir, "../../../examples/extensions");

function setup() {
  cli = createTestCli({ runtime: { platform: process.platform } });
  const paths = extensionPaths(join(cli.home, "data", "extensions"));
  const command = createExtCommand({
    confirm: async () => false,
    strictValidation: () => false,
    paths: () => paths,
  });
  const run = (dir: string) => command.run(["test", dir], cli!.context);
  const fixture = (manifest: string, files: Record<string, string>) => {
    const dir = join(cli!.home, "src", "fixture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "roamgate-extension.toml"), manifest);
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, name), text);
    return dir;
  };
  return { cli, run, fixture };
}

const GATE_MANIFEST = `id = "acme.gate"
name = "Gate"
version = "1.0.0"
api = "^1.0"
capabilities = ["gates"]
mod = "./mod.ts"
`;

test("AC-01-41: ext test runs guard-rails against the fake host and passes", async () => {
  const { cli, run } = setup();
  expect(await run(join(examples, "guard-rails"))).toBe(EXIT_OK);
  const report = cli.errors.join("\n");
  expect(report).toContain("closing a pane with a working agent is denied");
  expect(report).toMatch(/[1-9]\d* pass/);
  expect(report).toContain(" 0 fail");
}, 60_000);

test("ext test runs the hello example", async () => {
  const { cli, run } = setup();
  expect(await run(join(examples, "hello"))).toBe(EXIT_OK);
  expect(cli.errors.join("\n")).toContain(" 0 fail");
}, 60_000);

test("ext test exits 1 when a test fails", async () => {
  const { cli, run, fixture } = setup();
  const dir = fixture(GATE_MANIFEST, {
    "mod.ts": `export function register(on) {
  on("pane.close", {}, () => ({ decision: "deny", reason: "never" }));
}`,
    "gate.test.ts": `import { afterEach, expect, test } from "bun:test";
import { createFakeHost } from "roamgate:testing";
let host;
afterEach(() => host?.close());
test("expects an allow the mod never gives", async () => {
  host = await createFakeHost({ dir: import.meta.dir });
  expect(await host.gate({ name: "pane.close", pane_id: "p1" })).toEqual({ decision: "allow" });
});`,
  });
  expect(await run(dir)).toBe(EXIT_FAILURE);
  const report = cli.errors.join("\n");
  expect(report).toContain("expects an allow the mod never gives");
  expect(report).toContain("1 fail");
}, 60_000);

test("ext test exits 2 on validation errors without running tests", async () => {
  const { cli, run, fixture } = setup();
  const dir = fixture(GATE_MANIFEST.replace('"gates"', '"teleport"'), {
    "mod.ts": "export function register() {}",
    "never.test.ts": `throw new Error("must not run");`,
  });
  expect(await run(dir)).toBe(EXIT_USAGE);
  expect(cli.errors.join("\n")).toContain("error:");
  expect(cli.errors.join("\n")).not.toContain("must not run");
});
