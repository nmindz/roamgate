import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gateRpcAction } from "./action-events";
import { ApprovalService, installApprovals } from "./approvals";
import {
  HOOK_OUTPUT_MAX_BYTES,
  resolveHookArgv,
  runCommandHook,
} from "./command-hooks";
import type { DollarConnectionLease } from "./dollar";
import type { ExtensionRegistry } from "./registry";
import { createExtensionSandbox } from "./test-fixtures";

const sandbox = createExtensionSandbox();
afterEach(() => sandbox.cleanup());

const connection = { id: "c1", generation: 1 };

interface HookSpec {
  on?: string;
  script: string;
  timeout?: number;
  on_failure?: "continue" | "block";
  matcher?: string;
}

function hookToml(file: string, spec: HookSpec): string {
  return `
[[hooks]]
on = ${JSON.stringify(spec.on ?? "pane.close")}
command = ["roamgate:bun", "./hooks/${file}"]
${spec.timeout === undefined ? "" : `timeout = ${spec.timeout}`}
${spec.on_failure === undefined ? "" : `on_failure = ${JSON.stringify(spec.on_failure)}`}
${spec.matcher === undefined ? "" : `matcher = ${spec.matcher}`}
`;
}

/** Links an extension whose hooks are the given scripts; `mod` is optional. */
function linkHooks(
  registry: ExtensionRegistry,
  id: string,
  hooks: HookSpec[],
  options: { mod?: string; manifest?: string } = {},
): string {
  const dir = join(sandbox.root, "src", id);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  hooks.forEach((hook, index) =>
    writeFileSync(join(dir, "hooks", `h${index}.ts`), hook.script),
  );
  return sandbox.link(
    id,
    options.mod ?? null,
    `${options.manifest ?? ""}\n${hooks
      .map((hook, index) => hookToml(`h${index}.ts`, hook))
      .join("\n")}`,
    registry,
  );
}

function start(registry: ExtensionRegistry) {
  const { host, bus } = sandbox.host(registry);
  host.start();
  return { host, bus };
}

const dataFile = (id: string, name: string) =>
  join(sandbox.paths.dataDir(id), name);

function withApprovals(answer: "approve" | "deny") {
  const asked: string[] = [];
  const approvals = new ApprovalService({
    announce: (pending) => {
      asked.push(pending.title);
      approvals.answer(pending.id, answer, "test");
    },
  });
  const off = installApprovals(approvals);
  return {
    asked,
    dispose: () => {
      off();
      approvals.dispose();
    },
  };
}

test("AC-01-19: a hook exiting 2 denies the action with its stderr as the reason", async () => {
  const registry = sandbox.registry();
  linkHooks(registry, "deny-close", [
    {
      script: `console.error("pane p1 is protected"); process.exit(2);`,
    },
  ]);
  const { bus, host } = start(registry);
  expect(bus.wants("pane.close")).toBe(true);
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
  ).rejects.toThrow("Denied by extension deny-close: pane p1 is protected");
  // Hooks never start a mod, and a deny is not a failure.
  expect(host.isRunning("deny-close")).toBe(false);
  expect(registry.get("deny-close")?.failures).toEqual([]);
});

test('AC-01-19: a hook printing {"decision":"ask"} runs the approval flow', async () => {
  const registry = sandbox.registry();
  linkHooks(registry, "ask-close", [
    {
      script: `console.log(JSON.stringify({ decision: "ask", reason: "Close the deploy pane?" }));`,
    },
  ]);
  const { bus } = start(registry);
  const approve = withApprovals("approve");
  try {
    const params = { pane_id: "p1" };
    expect(
      await gateRpcAction(connection, "pane.close", params, { bus }),
    ).toEqual(params);
    expect(approve.asked).toEqual(["Close the deploy pane?"]);
  } finally {
    approve.dispose();
  }
  const deny = withApprovals("deny");
  try {
    await expect(
      gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
    ).rejects.toThrow();
    expect(deny.asked).toEqual(["Close the deploy pane?"]);
  } finally {
    deny.dispose();
  }
});

test("AC-01-19: a hook past its timeout is killed with its process tree and on_failure decides", async () => {
  const registry = sandbox.registry();
  const script = `
const child = Bun.spawn(["sleep", "30"]);
await Bun.write(process.env.ROAMGATE_EXTENSION_DATA + "/child.pid", String(child.pid));
await Bun.sleep(30_000);
`;
  linkHooks(registry, "slow-block", [
    { script, timeout: 1, on_failure: "block" },
  ]);
  const { bus, host } = start(registry);
  const started = Date.now();
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
  ).rejects.toThrow("Denied by extension slow-block: extension error");
  expect(Date.now() - started).toBeLessThan(5_000);
  const failures = registry.get("slow-block")?.failures ?? [];
  expect(failures).toHaveLength(1);
  expect(failures[0]?.error).toContain("timed out after 1000ms");
  expect(
    host.logs("slow-block").some((entry) => entry.line.includes("timed out")),
  ).toBe(true);

  const pid = Number(readFileSync(dataFile("slow-block", "child.pid"), "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Reaping the orphaned child is asynchronous; nothing signals it.
  for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(50);
  expect(alive()).toBe(false);
}, 10_000);

test("a timed-out hook under on_failure continue lets the action through", async () => {
  const registry = sandbox.registry();
  linkHooks(registry, "slow-continue", [
    { script: "await Bun.sleep(30_000);", timeout: 1 },
  ]);
  const { bus } = start(registry);
  const params = { pane_id: "p1" };
  expect(await gateRpcAction(connection, "pane.close", params, { bus })).toBe(
    params,
  );
  expect(registry.get("slow-continue")?.failures).toHaveLength(1);
});

test("output past 1 MiB is a failure, and on_failure block denies", async () => {
  const registry = sandbox.registry();
  linkHooks(registry, "chatty", [
    {
      script: `await Bun.write(Bun.stdout, "x".repeat(${HOOK_OUTPUT_MAX_BYTES * 2}));`,
      on_failure: "block",
    },
  ]);
  const { bus } = start(registry);
  await expect(
    gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus }),
  ).rejects.toThrow("extension error");
  expect(registry.get("chatty")?.failures[0]?.error).toContain(
    `output exceeded ${HOOK_OUTPUT_MAX_BYTES} bytes`,
  );
});

test("any other exit code is a failure recorded like a handler failure", async () => {
  const registry = sandbox.registry();
  linkHooks(registry, "broken", [
    { script: `console.error("boom"); process.exit(3);` },
  ]);
  const { bus } = start(registry);
  const params = { pane_id: "p1" };
  expect(await gateRpcAction(connection, "pane.close", params, { bus })).toBe(
    params,
  );
  expect(registry.get("broken")?.failures[0]?.error).toContain(
    "exited with code 3: boom",
  );
});

const DOCUMENTED_ENV = [
  "ROAMGATE_EXTENSION_ID",
  "ROAMGATE_EXTENSION_ROOT",
  "ROAMGATE_EXTENSION_DATA",
  "ROAMGATE_EVENT",
  "ROAMGATE_CONNECTION_ID",
  "ROAMGATE_WORKSPACE_ID",
  "ROAMGATE_PANE_ID",
  "ROAMGATE_CHECKOUT_PATH",
];
const CREDENTIALS = {
  ROAMGATE_PASSWORD: "pw-secret-value",
  ROAMGATE_PIN: "424242",
  ROAMGATE_TOKEN: "tok-secret-value",
  HERDR_GUI_TOKEN: "legacy-secret-value",
  ROAMGATE_SESSION_SECRET: "session-secret-value",
};

// Reads documented names only; credentials are reported by presence, never value.
const ENV_PROBE = `
const documented = Object.fromEntries(
  ${JSON.stringify(DOCUMENTED_ENV)}.map((name) => [name, process.env[name] ?? null]),
);
const present = ${JSON.stringify([...Object.keys(CREDENTIALS), "UNRELATED"])}.filter(
  (name) => name in process.env,
);
const dir = process.env.ROAMGATE_EXTENSION_DATA;
await Bun.write(dir + "/probe.json", JSON.stringify({ documented, present }));
await Bun.write(dir + "/event.json", await Bun.stdin.text());
`;

function readProbe(id: string) {
  return JSON.parse(readFileSync(dataFile(id, "probe.json"), "utf8")) as {
    documented: Record<string, string | null>;
    present: string[];
  };
}

test("AC-01-20: the hook environment has the documented variables and no credentials", async () => {
  const saved = Object.fromEntries(
    Object.keys(CREDENTIALS).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, CREDENTIALS);
  try {
    const registry = sandbox.registry();
    const root = linkHooks(registry, "env-probe", [{ script: ENV_PROBE }]);
    const { bus } = start(registry);
    await gateRpcAction(connection, "pane.close", { pane_id: "p7" }, { bus });
    const probe = readProbe("env-probe");
    expect(probe.documented).toMatchObject({
      ROAMGATE_EXTENSION_ID: "env-probe",
      ROAMGATE_EXTENSION_ROOT: realpathSync(root),
      ROAMGATE_EXTENSION_DATA: sandbox.paths.dataDir("env-probe"),
      ROAMGATE_EVENT: "pane.close",
      ROAMGATE_CONNECTION_ID: "c1",
      ROAMGATE_PANE_ID: "p7",
    });
    expect(probe.present).toEqual([]);
    const event = JSON.parse(
      readFileSync(dataFile("env-probe", "event.json"), "utf8"),
    );
    expect(event).toMatchObject({
      name: "pane.close",
      pane_id: "p7",
      connection,
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("AC-01-20: workspace and checkout variables come from the event", async () => {
  const registry = sandbox.registry();
  const root = linkHooks(registry, "env-direct", [{ script: ENV_PROBE }]);
  const result = await runCommandHook(
    {
      ext: "env-direct",
      root,
      paths: sandbox.paths,
      hook: {
        on: "worktree.remove",
        command: ["roamgate:bun", "./hooks/h0.ts"],
      },
    },
    {
      name: "worktree.remove",
      at: 1,
      connection,
      workspace_id: "w1",
      pane_id: "p1",
      checkout_path: "/repo/wt",
    },
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...CREDENTIALS,
        UNRELATED: "x",
      },
    },
  );
  expect(result).toEqual({ ok: true });
  const probe = readProbe("env-direct");
  expect(probe.documented).toMatchObject({
    ROAMGATE_EVENT: "worktree.remove",
    ROAMGATE_CONNECTION_ID: "c1",
    ROAMGATE_WORKSPACE_ID: "w1",
    ROAMGATE_PANE_ID: "p1",
    ROAMGATE_CHECKOUT_PATH: "/repo/wt",
  });
  expect(probe.present).toEqual([]);
});

test("hooks run in parallel and combine with mod gates deny > ask > allow", async () => {
  const registry = sandbox.registry();
  linkHooks(registry, "mod-ask", [{ script: "await Bun.sleep(800);" }], {
    mod: `export function register(on) {
  on("pane.close", {}, () => ({ decision: "ask", title: "Mod asks" }));
}`,
    manifest: 'activation = ["event:pane.close"]',
  });
  linkHooks(registry, "hooks-allow", [
    {
      script: `await Bun.sleep(800); console.log(JSON.stringify({ decision: "allow" }));`,
    },
    {
      script: `await Bun.sleep(800); console.log(JSON.stringify({ decision: "allow" }));`,
    },
  ]);
  const { bus } = start(registry);

  // ask (mod) + allow (hooks) asks; the three 800 ms hooks overlap.
  const approve = withApprovals("approve");
  try {
    const started = Date.now();
    await gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(approve.asked).toEqual(["Mod asks"]);
  } finally {
    approve.dispose();
  }

  // Second round: a fresh host picks up hook-deny, which joins the same event.
  linkHooks(registry, "hook-deny", [
    { script: `console.error("hook says no"); process.exit(2);` },
  ]);
  const { bus: bus2 } = start(registry);
  const asked = withApprovals("approve");
  try {
    await expect(
      gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus: bus2 }),
    ).rejects.toThrow("Denied by extension hook-deny: hook says no");
    expect(asked.asked).toEqual([]);
  } finally {
    asked.dispose();
  }
}, 15_000);

test("a hook-only extension's hook does not activate the mod of its extension", async () => {
  const registry = sandbox.registry();
  linkHooks(
    registry,
    "lazy",
    [
      {
        script: `await Bun.write(process.env.ROAMGATE_EXTENSION_DATA + "/ran", "1");`,
      },
    ],
    {
      mod: `export function register(on) {
  on("terminal.submit", {}, () => ({ decision: "allow" }));
}`,
      manifest: 'activation = ["event:terminal.submit"]',
    },
  );
  const { bus, host } = start(registry);
  await gateRpcAction(connection, "pane.close", { pane_id: "p1" }, { bus });
  expect(existsSync(dataFile("lazy", "ran"))).toBe(true);
  expect(host.isRunning("lazy")).toBe(false);
});

test("matchers filter hooks and rewrites follow the host's rewrite rules", async () => {
  const registry = sandbox.registry();
  linkHooks(registry, "rewriter", [
    {
      on: "terminal.submit",
      matcher: '{ pane_id = "p1" }',
      script: `
const event = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify({
  rewrite: { text: event.text + "!", pane_id: "elsewhere" },
  message: "added emphasis",
}));`,
    },
  ]);
  const { bus, host } = start(registry);
  const matched = await bus.gate({
    name: "terminal.submit",
    pane_id: "p1",
    text: "hi",
  });
  expect(matched.gate.decision).toBe("allow");
  expect(matched.event.text).toBe("hi!");
  expect(matched.event.pane_id).toBe("p1");
  const lines = host.logs("rewriter").map((entry) => entry.line);
  expect(lines.some((line) => line.includes("added emphasis"))).toBe(true);
  expect(
    lines.some((line) => line.includes("ignored changes to pane_id")),
  ).toBe(true);
  const other = await bus.gate({
    name: "terminal.submit",
    pane_id: "p2",
    text: "hi",
  });
  expect(other.event.text).toBe("hi");
});

test("safe mode runs no hook", async () => {
  const registry = sandbox.registry({ safeModeFlag: true });
  linkHooks(registry, "safe", [
    {
      script: `await Bun.write(process.env.ROAMGATE_EXTENSION_DATA + "/ran", "1"); process.exit(2);`,
    },
  ]);
  const { bus } = start(registry);
  expect(bus.wants("pane.close")).toBe(false);
  const params = { pane_id: "p1" };
  expect(await gateRpcAction(connection, "pane.close", params, { bus })).toBe(
    params,
  );
  expect(existsSync(dataFile("safe", "ran"))).toBe(false);
});

test("disabled extensions run no hook", async () => {
  const registry = sandbox.registry();
  linkHooks(registry, "off", [{ script: "process.exit(2);" }]);
  registry.setEnabled("off", false);
  const { bus } = start(registry);
  expect(bus.wants("pane.close")).toBe(false);
});

test("script paths must stay inside the extension directory after realpath", async () => {
  const root = join(sandbox.root, "src", "escape");
  mkdirSync(join(root, "hooks"), { recursive: true });
  const outside = join(sandbox.root, "outside.ts");
  writeFileSync(outside, "process.exit(0);");
  symlinkSync(outside, join(root, "hooks", "link.ts"));
  writeFileSync(join(root, "hooks", "ok.ts"), "");
  await expect(
    resolveHookArgv(root, ["roamgate:bun", "./hooks/link.ts"]),
  ).rejects.toThrow("outside the extension directory");
  await expect(
    resolveHookArgv(root, ["roamgate:bun", "/etc/hosts"]),
  ).rejects.toThrow("relative to the extension directory");
  const resolved = await resolveHookArgv(
    root,
    ["roamgate:bun", "hooks/ok.ts", "--flag"],
    "/opt/roamgate",
  );
  const realRoot = realpathSync(root);
  expect(resolved.argv).toEqual([
    "/opt/roamgate",
    "run",
    join(realRoot, "hooks", "ok.ts"),
    "--flag",
  ]);
  expect(resolved.env).toEqual({ BUN_BE_BUN: "1" });
  const plain = await resolveHookArgv(root, ["python3", "./hooks/ok.ts"]);
  expect(plain).toEqual({
    argv: ["python3", join(realRoot, "hooks", "ok.ts")],
    env: {},
  });
});

test("the guard-rails audit hook writes closes.log on pane.close", async () => {
  const example = join(
    import.meta.dir,
    "../../../examples/extensions/guard-rails",
  );
  const registry = sandbox.registry();
  registry.add({
    id: "roamgate.guard-rails",
    source: { kind: "link", location: example },
    version: "1.0.0",
    path: example,
    enabled: true,
  });
  const lease: DollarConnectionLease = {
    connectionId: "c1",
    generation: 1,
    isCurrent: () => true,
    call: async (method) => {
      if (method === "agent.list") return { agents: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
  const { host, bus } = sandbox.host(registry, {
    readConfig: async () => ({ protected_pattern: "prod" }),
    dollar: { lease: () => lease },
  });
  host.start();
  await gateRpcAction(connection, "pane.close", { pane_id: "p2" }, { bus });
  const log = dataFile("roamgate.guard-rails", "closes.log");
  expect(existsSync(log)).toBe(true);
  expect(readFileSync(log, "utf8")).toMatch(/ browser p2\n$/);
  expect(dirname(log)).toBe(sandbox.paths.dataDir("roamgate.guard-rails"));
}, 10_000);
