import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXTENSION_API_VERSION,
  EXTENSION_RPC_ERRORS,
  type ExtensionManifest,
} from "../../../shared/extensions";
import { silentLogger } from "../utils/logger";
import { runCommandHook } from "./command-hooks";
import { createDollarDispatcher, type DollarConnectionLease } from "./dollar";
import { ExtensionBus } from "./events";
import { ExtensionStore } from "./store";
import { createExtensionSandbox } from "./test-fixtures";

let sandbox = createExtensionSandbox();
const restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await sandbox.cleanup();
  sandbox = createExtensionSandbox();
});

const SHELLS = ["sh", "bash", "zsh", "cmd", "cmd.exe", "powershell"];

/** Every Bun.spawn argv from here on; the real spawn still runs. */
function spawnSpy() {
  const spy = spyOn(Bun, "spawn");
  restores.push(() => spy.mockRestore());
  return () =>
    spy.mock.calls.map((call) => {
      const argv = call[0];
      expect(Array.isArray(argv)).toBe(true);
      return argv as unknown as string[];
    });
}

function noShell(argv: string[]) {
  const program = argv[0]?.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  expect(SHELLS).not.toContain(program);
  expect(argv).not.toContain("-c");
  expect(argv).not.toContain("/c");
}

test("$.process.run with a Windows-host connection fails clearly and starts nothing", async () => {
  const calls = spawnSpy();
  const lease: DollarConnectionLease = {
    connectionId: "win",
    generation: 1,
    isCurrent: () => true,
    call: async () => ({}),
    sshHost: "winbox",
    remotePlatform: "windows",
  };
  const dollar = createDollarDispatcher({
    ext: "acme.remote",
    manifest: {
      capabilities: ["process.remote"],
      network_hosts: [],
    } as unknown as ExtensionManifest,
    store: new ExtensionStore(sandbox.paths, "acme.remote"),
    root: sandbox.root,
    host: {
      lease: () => lease,
      connections: () => [],
      notify: () => undefined,
      toast: () => undefined,
      invalidate: () => undefined,
      bus: new ExtensionBus(silentLogger),
    },
  });
  for (const options of [
    { connection: "win" },
    { connection: "win", readOnly: true, cwd: "/srv" },
  ]) {
    const failure = dollar.call("process", "run", [["ls", "-la"], options]);
    await expect(failure).rejects.toThrow("unsupported on this connection");
    await expect(failure).rejects.toMatchObject({
      code: EXTENSION_RPC_ERRORS.invalidParams,
    });
  }
  expect(calls()).toEqual([]);
});

test("the extension child starts from an argv array, never through a shell", async () => {
  const registry = sandbox.registry();
  const root = sandbox.link(
    "acme.argv",
    "export function register() {}",
    'activation = ["startup"]',
    registry,
  );
  const calls = spawnSpy();
  const { host } = sandbox.host(registry);
  const { promise, resolve } = Promise.withResolvers<void>();
  const off = host.onChange(() => {
    if (host.isRunning("acme.argv")) resolve();
  });
  host.start();
  if (host.isRunning("acme.argv")) resolve();
  await promise;
  off();
  const argv = calls().find((entry) => entry.includes("__ext-host"));
  expect(argv).toBeDefined();
  noShell(argv!);
  expect(argv![0]).toBe(process.execPath);
  expect(argv!.slice(argv!.indexOf("__ext-host"))).toEqual([
    "__ext-host",
    "--root",
    realpathSync(root),
    "--id",
    "acme.argv",
    "--api",
    EXTENSION_API_VERSION,
  ]);
}, 20_000);

test("a command hook runs its argv as given: shell syntax in arguments stays literal", async () => {
  const root = join(sandbox.root, "src", "acme.hooks");
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(
    join(root, "hooks", "argv.ts"),
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.env.ROAMGATE_EXTENSION_DATA!, "argv.json"), JSON.stringify(process.argv.slice(2)));
`,
  );
  const literal = "a b; echo pwned $(whoami) `id` | cat > x && exit 1";
  const calls = spawnSpy();
  const result = await runCommandHook(
    {
      ext: "acme.hooks",
      root,
      paths: sandbox.paths,
      hook: {
        on: "pane.close",
        command: ["roamgate:bun", "./hooks/argv.ts", literal, "%PATH%"],
      },
    },
    { name: "pane.close", at: Date.now(), pane_id: "p1" },
  );
  expect(result).toEqual({ ok: true });
  const [argv, ...others] = calls();
  expect(others).toEqual([]);
  noShell(argv!);
  expect(argv![0]).toBe(process.execPath);
  expect(argv!.slice(1)).toEqual([
    "run",
    expect.stringMatching(/[\\/]hooks[\\/]argv\.ts$/),
    literal,
    "%PATH%",
  ]);
  expect(
    JSON.parse(
      readFileSync(
        join(sandbox.paths.dataDir("acme.hooks"), "argv.json"),
        "utf8",
      ),
    ),
  ).toEqual([literal, "%PATH%"]);
}, 20_000);
