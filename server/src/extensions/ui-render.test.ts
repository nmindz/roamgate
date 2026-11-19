import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUiRenderResult } from "../../../shared/extensions";
import { readExtensionConfig, writeExtensionConfig } from "./config";
import type { DollarConnectionLease } from "./dollar";
import type { ExtensionInstaller, InstallPreviews } from "./install";
import type { ExtensionRegistry } from "./registry";
import { createExtensionRpc } from "./rpc";
import { createExtensionSandbox } from "./test-fixtures";

// Settings live in a throwaway file for this suite.
const settingsDir = mkdtempSync(join(tmpdir(), "roamgate-ext-settings-"));
process.env.ROAMGATE_SETTINGS_PATH = join(settingsDir, "settings.json");
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }));

const sandbox = createExtensionSandbox();
afterEach(() => sandbox.cleanup());

const ciBadges = join(
  import.meta.dir,
  "../../../examples/extensions/ci-badges",
);

function rpcFor(
  registry: ExtensionRegistry,
  options: Parameters<typeof sandbox.host>[1] = {},
) {
  const { host } = sandbox.host(registry, options);
  host.start();
  return createExtensionRpc({
    registry,
    host,
    installer: {} as ExtensionInstaller,
    previews: {} as InstallPreviews,
    broadcast: () => undefined,
  });
}

test("ui.render routes to slot contributors, matches `when`, and reports failures per entry", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.badges",
    `export function register(on) {
      on("ui.render", { slot: "workspace.badge" }, (_$, event) =>
        event.entry_id === "boom" ? Promise.reject(new Error("broken")) :
        ({ text: event.entry_id + ":" + event.context.workspace_id, tone: "info", tooltip: "t" }));
    }`,
    `capabilities = ["ui"]
activation = ["slot:workspace.badge"]
[[slots]]
slot = "workspace.badge"
id = "always"
[[slots]]
slot = "workspace.badge"
id = "remote-only"
when = { remote = true }
[[slots]]
slot = "workspace.badge"
id = "boom"`,
    registry,
  );
  const rpc = rpcFor(registry);
  const result = (await rpc.handle("ext.ui.render", {
    slot: "workspace.badge",
    context: { workspace_id: "w1", remote: false },
  })) as ExtensionUiRenderResult;
  expect(result.entries).toEqual([
    {
      ext: "acme.badges",
      entry_id: "always",
      value: { text: "always:w1", tone: "info", tooltip: "t" },
    },
    {
      ext: "acme.badges",
      entry_id: "boom",
      value: { error: expect.any(String) },
    },
  ]);
  expect(
    (
      (await rpc.handle("ext.ui.render", {
        slot: "statusbar.item",
      })) as ExtensionUiRenderResult
    ).entries,
  ).toEqual([]);
});

test("a hidden entry never activates its mod; ui.action reaches the contributor", async () => {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.panel",
    `export function register(on) {
      on("ui.action", { slot: "inspector.panel" }, (_$, event) => ({ clicked: event.element_id, value: event.value }));
    }`,
    `capabilities = ["ui"]
activation = ["slot:inspector.panel"]
[[slots]]
slot = "inspector.panel"
id = "p"
when = { agent = "omp" }`,
    registry,
  );
  const { host } = sandbox.host(registry);
  host.start();
  const rpc = createExtensionRpc({
    registry,
    host,
    installer: {} as ExtensionInstaller,
    previews: {} as InstallPreviews,
    broadcast: () => undefined,
  });
  await rpc.handle("ext.ui.render", {
    slot: "inspector.panel",
    context: { agent: "claude" },
  });
  expect(host.isRunning("acme.panel")).toBe(false);
  expect(
    await rpc.handle("ext.ui.action", {
      ext: "acme.panel",
      slot: "inspector.panel",
      entry_id: "p",
      element_id: "go",
      value: 3,
    }),
  ).toEqual({ result: { clicked: "go", value: 3 } });
  await expect(
    rpc.handle("ext.ui.action", {
      ext: "acme.panel",
      slot: "topbar.item",
      entry_id: "p",
      element_id: "go",
    }),
  ).rejects.toThrow("contributes nothing");
});

test("ci-badges renders a badge and an Inspector tree from gh on the connection, with connection-scoped config", async () => {
  const registry = sandbox.registry();
  registry.add({
    id: "roamgate.ci-badges",
    source: { kind: "link", location: ciBadges },
    version: "1.0.0",
    path: ciBadges,
    enabled: true,
  });
  const manifest = registry.validate(registry.get("roamgate.ci-badges")!)
    .manifest!;
  await writeExtensionConfig(manifest, "branch", "main", "remote-a");
  await writeExtensionConfig(manifest, "branch", "dev", "remote-b");
  expect((await readExtensionConfig(manifest, "remote-a")).branch).toBe("main");
  expect((await readExtensionConfig(manifest, "remote-b")).branch).toBe("dev");
  expect((await readExtensionConfig(manifest)).branch).toBeNull();

  const leases = new Map<string, DollarConnectionLease>(
    ["remote-a", "remote-b"].map((id) => [
      id,
      {
        connectionId: id,
        generation: 1,
        isCurrent: () => true,
        call: async () => null,
        // Local leases: the mod must fall back from `connection` to a local run.
        sshHost: undefined,
      },
    ]),
  );
  const rpc = rpcFor(registry, {
    readConfig: (id, connectionId) => {
      const record = registry.get(id)!;
      return readExtensionConfig(
        registry.validate(record).manifest!,
        connectionId,
      );
    },
    dollar: { lease: (id) => (id ? (leases.get(id) ?? null) : null) },
  });
  // Without a checkout the mod has nothing to show.
  const empty = (await rpc.handle("ext.ui.render", {
    slot: "inspector.panel",
    context: { connection_id: "remote-a", generation: 1 },
  })) as ExtensionUiRenderResult;
  expect(empty.entries).toEqual([
    {
      ext: "roamgate.ci-badges",
      entry_id: "runs",
      value: expect.objectContaining({ t: "Empty", title: "No CI runs" }),
    },
  ]);
});
