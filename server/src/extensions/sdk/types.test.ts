import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EXIT_OK } from "../../cli/command";
import { createExtCommand } from "../../cli/ext";
import { createTestCli, type TestCli } from "../../cli/test-context";
import { extensionPaths } from "../paths";
import { SDK_TSCONFIG, SDK_TYPES } from "./types-source";

const repo = join(import.meta.dir, "../../../..");
const examples = join(repo, "examples/extensions");
const TSC = join(repo, "node_modules/typescript/bin/tsc");

let cli: TestCli | undefined;
afterEach(() => cli?.cleanup());

function setup() {
  cli = createTestCli({ runtime: { platform: process.platform } });
  const paths = extensionPaths(join(cli.home, "data", "extensions"));
  const command = createExtCommand({
    confirm: async () => false,
    strictValidation: () => false,
    paths: () => paths,
  });
  return {
    cli,
    types: (...args: string[]) => command.run(["types", ...args], cli!.context),
  };
}

/** `tsc --noEmit` over `dir` with its tsconfig.json, Bun's types and the repo's node_modules. */
async function typecheck(dir: string) {
  symlinkSync(
    join(repo, "node_modules"),
    join(dir, "node_modules"),
    "junction",
  );
  writeFileSync(
    join(dir, "tsconfig.check.json"),
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { types: ["bun-types"] },
    }),
  );
  const proc = Bun.spawn(
    [process.execPath, TSC, "--noEmit", "-p", "tsconfig.check.json"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: stdout + stderr };
}

test("ext types writes roamgate.d.ts and a tsconfig.json only when there is none", async () => {
  const { cli, types } = setup();
  const dir = join(cli.home, "mod");
  expect(await types(dir)).toBe(EXIT_OK);
  expect(readFileSync(join(dir, "roamgate.d.ts"), "utf8")).toBe(
    readFileSync(join(import.meta.dir, "types.d.ts"), "utf8"),
  );
  expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toBe(SDK_TSCONFIG);

  writeFileSync(join(dir, "tsconfig.json"), "{}");
  expect(await types(dir)).toBe(EXIT_OK);
  expect(readFileSync(join(dir, "tsconfig.json"), "utf8")).toBe("{}");
  expect(cli.output.join("\n")).toContain("make sure its include covers");

  const file = join(cli.home, "out", "sdk.d.ts");
  expect(await types("--output", file)).toBe(EXIT_OK);
  expect(readFileSync(file, "utf8")).toBe(SDK_TYPES);
  expect(existsSync(join(cli.home, "out", "tsconfig.json"))).toBe(false);
});

test("every $ method Roamgate answers is declared in roamgate.d.ts", () => {
  const dollar = readFileSync(join(import.meta.dir, "../dollar.ts"), "utf8");
  const handled = [...dollar.matchAll(/^ {4}"([a-z]+)\.([A-Za-z]+)":/gm)].map(
    ([, ns, method]) => [ns!, method!] as const,
  );
  expect(handled.length).toBeGreaterThan(20);
  const start = SDK_TYPES.indexOf("export interface Dollar {");
  const declared = SDK_TYPES.slice(
    start,
    SDK_TYPES.indexOf("\n  }\n", start) + 4,
  );
  for (const [ns, method] of handled) {
    const namespace = new RegExp(`\\n {4}${ns}: \\{([\\s\\S]*?)\\n {4}\\};`);
    const body = namespace.exec(declared)?.[1];
    expect(body, `$.${ns}`).toBeDefined();
    expect(body, `$.${ns}.${method}`).toMatch(
      new RegExp(`\\n {6}${method}\\(`),
    );
  }
  for (const local of ["state", "clock", "log"])
    expect(declared).toContain(`\n    ${local}: `);
});

test("AC-01-33: ext types output type-checks the reference extensions and their tests", async () => {
  const { cli, types } = setup();
  for (const name of ["hello", "guard-rails", "ci-badges", "local-web-app"]) {
    const dir = join(cli.home, name);
    cpSync(join(examples, name), dir, { recursive: true });
    expect(await types(dir)).toBe(EXIT_OK);
    const { code, output } = await typecheck(dir);
    expect(output).toBe("");
    expect(code).toBe(0);
  }
}, 120_000);

test("the declarations reject answers an event does not take", async () => {
  const { cli, types } = setup();
  const dir = join(cli.home, "wrong");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "mod.ts"),
    `import type { On } from "roamgate";
export function register(on: On) {
  on("pane.close", () => ({ decision: "allow" }));
  on("ui.render", { slot: "statusbar.item" }, () => ({ text: "x", tone: "info" }));
  // @ts-expect-error: not a Gate decision
  on("pane.close", () => ({ decision: "maybe" }));
  // @ts-expect-error: not an element or slot data
  on("ui.render", () => ({ t: "Blink" }));
  // @ts-expect-error: not an event
  on("pane.explode", () => undefined);
  on("tool.lookup", (_$, event) => event.input);
  on("worktree.remove", (_$, event) => {
    const force: boolean | undefined = event.force;
    return force ? { decision: "deny", reason: "forced" } : undefined;
  });
}
`,
  );
  expect(await types(dir)).toBe(EXIT_OK);
  const { code, output } = await typecheck(dir);
  expect(output).toBe("");
  expect(code).toBe(0);
}, 60_000);
