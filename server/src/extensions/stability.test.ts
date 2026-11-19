import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  API_STABILITY,
  EXPERIMENTAL_EVENTS,
  EXTENSION_EVENTS,
  type ExtensionApiStability,
  eventStability,
  methodStability,
} from "../../../shared/extensions";
import { createExtCommand } from "../cli/ext";
import { createTestCli, type TestCli } from "../cli/test-context";
import { gateRpcAction } from "./action-events";
import { analyzeExtension } from "./analyze";
import { validateExtensionDir } from "./manifest";
import { extensionPaths } from "./paths";
import { createExtensionSandbox } from "./test-fixtures";

let sandbox = createExtensionSandbox();
let cli: TestCli | undefined;
afterEach(async () => {
  cli?.cleanup();
  cli = undefined;
  await sandbox.cleanup();
  sandbox = createExtensionSandbox();
});

const deprecated = { stability: "deprecated", since: "1.0" } as const;
const TEST_STABILITY: ExtensionApiStability = {
  events: {
    ...API_STABILITY.events,
    "agent.status": { ...deprecated, replacement: "agent.attention" },
    "terminal.submit": deprecated,
  },
  methods: {
    ...API_STABILITY.methods,
    "store.get": { ...deprecated, replacement: "$.store.keys" },
    "http.fetch": { stability: "experimental" },
  },
};

describe("stability table", () => {
  test("every event and every bridge $ method has a marker", () => {
    for (const event of EXTENSION_EVENTS)
      expect(eventStability(event)).toBeDefined();
    expect(eventStability("tool.lookup")?.stability).toBe("stable");
    expect(eventStability("nope")).toBeUndefined();

    const source = readFileSync(join(import.meta.dir, "dollar.ts"), "utf8");
    const handlers = [...source.matchAll(/^ {4}"([a-z]+\.[a-z_]+)":/gm)].map(
      (match) => match[1]!,
    );
    expect(handlers.length).toBeGreaterThan(20);
    for (const call of handlers) expect(methodStability(call)).toBeDefined();
    // Child-local namespaces never reach the bridge.
    for (const call of Object.keys(API_STABILITY.methods))
      if (!/^(state|clock|log)\./.test(call)) expect(handlers).toContain(call);
    expect(methodStability("state.get")?.stability).toBe("stable");
  });

  test("rpc.call is the experimental event", () => {
    expect([...EXPERIMENTAL_EVENTS]).toEqual(["rpc.call"]);
  });
});

describe("validation", () => {
  test("experimental events and methods need experimental = true", () => {
    const mod = `export function register(on, $) {
      on("rpc.call", async () => { await $.http.fetch("https://x.dev"); });
    }`;
    const dir = sandbox.link(
      "acme.exp",
      mod,
      'capabilities = ["network"]\n[[hooks]]\non = "rpc.call"\ncommand = ["true"]',
    );
    const validation = validateExtensionDir(dir, {
      appVersion: "0.8.15",
      stability: TEST_STABILITY,
    });
    expect(validation.errors).toEqual([
      "hooks[0].on: rpc.call is experimental and needs experimental = true",
    ]);
    const manifest = validateExtensionDir(
      sandbox.link(
        "acme.exp-on",
        mod,
        'capabilities = ["network"]\nexperimental = true',
      ),
      { appVersion: "0.8.15" },
    ).manifest!;
    expect(
      analyzeExtension(
        join(sandbox.root, "src", "acme.exp-on"),
        { ...manifest, experimental: false },
        TEST_STABILITY,
      ).errors,
    ).toEqual([
      "rpc.call is experimental and needs experimental = true",
      "$.http.fetch is experimental and needs experimental = true",
    ]);
    const optedIn = analyzeExtension(
      join(sandbox.root, "src", "acme.exp-on"),
      manifest,
      TEST_STABILITY,
    );
    expect(optedIn.errors).toEqual([]);
    expect(optedIn.warnings).toEqual([]);
  });

  test("deprecated events and methods warn in the manifest and the analysis", () => {
    const dir = sandbox.link(
      "acme.old",
      `export function register(on, $) {
        on("agent.status", async () => { await $.store.get("k"); });
      }`,
      '[[hooks]]\non = "terminal.submit"\ncommand = ["true"]',
    );
    const validation = validateExtensionDir(dir, {
      appVersion: "0.8.15",
      stability: TEST_STABILITY,
    });
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([
      "hooks[0].on: terminal.submit is deprecated since API 1.0 and will be removed in a later version",
    ]);
    const analysis = analyzeExtension(
      validation.root,
      validation.manifest!,
      TEST_STABILITY,
    );
    expect(analysis.errors).toEqual([]);
    expect(analysis.warnings).toEqual([
      "agent.status is deprecated since API 1.0 and will be removed in a later version; use agent.attention",
      "$.store.get is deprecated since API 1.0 and will be removed in a later version; use $.store.keys",
    ]);
  });

  test("ext validate prints deprecation warnings and fails on experimental use", async () => {
    cli = createTestCli({ runtime: { platform: process.platform } });
    const paths = extensionPaths(join(cli.home, "data", "extensions"));
    const command = createExtCommand({
      probe: async () => false,
      confirm: async () => false,
      strictValidation: () => false,
      paths: () => paths,
      stability: TEST_STABILITY,
    });
    const old = sandbox.link(
      "acme.old",
      `export function register(on, $) {
        on("agent.status", async () => { await $.store.get("k"); });
      }`,
    );
    expect(await command.run(["validate", old], cli.context)).toBe(0);
    const output = cli.output.join("\n");
    expect(output).toContain(
      "warning: agent.status is deprecated since API 1.0 and will be removed in a later version; use agent.attention",
    );
    expect(output).toContain(
      "warning: $.store.get is deprecated since API 1.0 and will be removed in a later version; use $.store.keys",
    );

    expect(await command.run(["validate", old, "--json"], cli.context)).toBe(0);
    expect(JSON.parse(cli.output.at(-1)!)).toMatchObject({
      ok: true,
      warnings: [
        expect.stringMatching(/^agent\.status is deprecated/),
        expect.stringMatching(/^\$\.store\.get is deprecated/),
      ],
    });

    const fetcher = sandbox.link(
      "acme.fetch",
      `export function register(on, $) {
        on("agent.status", async () => { await $.http.fetch("https://x.dev"); });
      }`,
      'capabilities = ["network"]',
    );
    expect(await command.run(["validate", fetcher], cli.context)).toBe(2);
    expect(cli.output.join("\n")).toContain(
      "error: $.http.fetch is experimental and needs experimental = true",
    );
  });
});

describe("runtime", () => {
  test("deprecated use is logged once per API per run, in the extension log", async () => {
    const registry = sandbox.registry();
    sandbox.link(
      "acme.old",
      `export function register(on, $) {
        on("terminal.submit", async ($, e, next) => {
          await $.store.get("a");
          await $.store.get("b");
          await $.store.set("seen", e.text);
          return next();
        });
      }`,
      'activation = ["event:terminal.submit"]',
      registry,
    );
    const { host, bus } = sandbox.host(registry, { stability: TEST_STABILITY });
    host.start();
    const submit = () =>
      gateRpcAction(
        { id: "local", generation: 1 },
        "pane.send_text",
        { pane_id: "w1:p1", text: "ls" },
        { bus },
      );
    await submit();
    await submit();

    const deprecations = host
      .logs("acme.old")
      .filter((entry) => entry.line.includes("is deprecated"));
    expect(deprecations.map((entry) => entry.level)).toEqual(["warn", "warn"]);
    expect(deprecations[0]?.line).toContain(
      "terminal.submit is deprecated since API 1.0",
    );
    expect(deprecations[1]?.line).toContain(
      "$.store.get is deprecated since API 1.0 and will be removed in a later version; use $.store.keys",
    );

    // `roamgate ext logs` reads this file. Appends are queued with no
    // completion signal, so poll for them.
    const file = join(sandbox.paths.logsDir("acme.old"), "extension.log");
    const deadline = Date.now() + 5_000;
    let text = "";
    while (Date.now() < deadline && !text.includes("$.store.get")) {
      await Bun.sleep(20);
      try {
        text = readFileSync(file, "utf8");
      } catch {}
    }
    expect(text.match(/\$\.store\.get is deprecated/g)).toHaveLength(1);
  }, 20_000);
});
