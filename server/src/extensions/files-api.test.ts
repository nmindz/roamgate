import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  EXTENSION_RPC_ERRORS,
  type ExtensionManifest,
} from "../../../shared/extensions";
import type { HerdrClient } from "../bridge/herdr-client";
import { silentLogger } from "../utils/logger";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { createFileHandlers } from "../workspace/files";
import {
  createDollarDispatcher,
  type DollarConnectionLease,
  type DollarHost,
} from "./dollar";
import { ExtensionBus } from "./events";
import { ExtensionStore } from "./store";
import { createExtensionSandbox } from "./test-fixtures";

const sandboxes: ReturnType<typeof createExtensionSandbox>[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.cleanup()));
});

/** A checkout `w1` with an outside directory next to it, behind a fake lease. */
function setup(
  capabilities: string[],
  options: { remote?: boolean; host?: Partial<DollarHost> } = {},
) {
  const sandbox = createExtensionSandbox();
  sandboxes.push(sandbox);
  const root = realpathSync(sandbox.root);
  const checkout = join(root, "checkout");
  const outside = join(root, "outside");
  mkdirSync(join(checkout, "docs"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(checkout, "leak.txt"));
  symlinkSync(outside, join(checkout, "out"));
  const files = createFileHandlers({
    herdr: {
      call: async (method: string, params: { workspace_id?: string }) => {
        if (method !== "workspace.get" || params.workspace_id !== "w1")
          throw new Error(`unexpected ${method}`);
        return { workspace: { workspace_id: "w1", cwd: checkout } };
      },
    } as unknown as HerdrClient,
    sshHost: () => (options.remote ? "dev-box" : undefined),
    // ssh's last argument is `bash -lc <script>`; a login shell would read rc files.
    runProcessWithCodeTimeout: (argv, timeoutMs) =>
      runProcessWithCodeTimeout(
        ["bash", "-c", (argv.at(-1) ?? "").replace(/^bash -lc /, "bash -c ")],
        timeoutMs,
      ),
    shQuote,
  });
  let generation = 1;
  const lease = (): DollarConnectionLease => ({
    connectionId: "laptop",
    generation,
    isCurrent: () => true,
    call: async () => ({}),
    files: {
      read: files.readWorkspaceFileBytes,
      write: files.uploadWorkspaceFile,
    },
  });
  const bus = options.host?.bus ?? new ExtensionBus(silentLogger);
  const dollar = createDollarDispatcher({
    ext: "acme.files",
    manifest: { capabilities } as unknown as ExtensionManifest,
    store: new ExtensionStore(sandbox.paths, "acme.files"),
    root,
    host: {
      lease,
      connections: () => [],
      notify: () => undefined,
      toast: () => undefined,
      invalidate: () => undefined,
      ...options.host,
      bus,
    },
  });
  const scope = {
    connection: { id: "laptop", generation: 1 },
    workspace_id: "w1",
  };
  return {
    checkout,
    outside,
    bus,
    scope,
    dollar,
    replace: () => generation++,
  };
}

test("$.files needs files.read to read and files.write to write", async () => {
  const reader = setup(["files.read"]);
  await expect(
    reader.dollar.call("files", "write", ["a.txt", "x"], reader.scope),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.capability });
  const writer = setup(["files.write"]);
  await expect(
    writer.dollar.call("files", "read", ["a.txt"], writer.scope),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.capability });
  const neither = setup(["workspace.read"]);
  for (const [method, args] of [
    ["read", ["a.txt"]],
    ["write", ["a.txt", "x"]],
  ] as const)
    await expect(
      neither.dollar.call("files", method, [...args], neither.scope),
    ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.capability });
});

test("$.files reads and writes round-trip in the event's checkout", async () => {
  const { dollar, checkout, scope } = setup(["files.read", "files.write"]);
  expect(
    await dollar.call("files", "write", ["docs/note.md", "héllo\n"], scope),
  ).toEqual({ ok: true, size: 7 });
  expect(readFileSync(join(checkout, "docs/note.md"), "utf8")).toBe("héllo\n");
  expect(await dollar.call("files", "read", ["docs/note.md"], scope)).toEqual({
    content: "héllo\n",
    encoding: "utf8",
    size: 7,
  });

  const binary = Buffer.from([0, 1, 2, 255]).toString("base64");
  await dollar.call(
    "files",
    "write",
    ["bin.dat", binary, { encoding: "base64" }],
    scope,
  );
  expect([...readFileSync(join(checkout, "bin.dat"))]).toEqual([0, 1, 2, 255]);
  expect(await dollar.call("files", "read", ["bin.dat"], scope)).toEqual({
    content: binary,
    encoding: "base64",
    size: 4,
  });
  await expect(
    dollar.call("files", "read", ["bin.dat", { encoding: "utf8" }], scope),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.invalidParams });

  // Outside an event, an explicit workspace names the checkout.
  expect(
    await dollar.call("files", "read", [
      "docs/note.md",
      { workspace_id: "w1" },
    ]),
  ).toMatchObject({ content: "héllo\n" });
  await expect(dollar.call("files", "read", ["docs/note.md"])).rejects.toThrow(
    "needs a workspace",
  );
});

test("$.files refuses paths that leave the checkout", async () => {
  const { dollar, outside, scope } = setup(["files.read", "files.write"]);
  for (const path of [
    "../outside/secret.txt",
    "docs/../../x",
    "/etc/hosts",
    join(outside, "secret.txt"),
  ])
    for (const [method, args] of [
      ["read", [path]],
      ["write", [path, "x"]],
    ] as const)
      await expect(
        dollar.call("files", method, [...args], scope),
      ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.invalidParams });
  await expect(
    dollar.call("files", "read", ["leak.txt"], scope),
  ).rejects.toThrow("escaped the workspace checkout");
  await expect(
    dollar.call("files", "write", ["out/new.txt", "x"], scope),
  ).rejects.toThrow("escaped the workspace checkout");
  await expect(
    dollar.call("files", "write", ["leak.txt", "x"], scope),
  ).rejects.toThrow("cannot overwrite a directory or symlink");
  expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
});

test("over SSH, the same checks refuse a symlink out of the checkout", async () => {
  const { dollar, checkout, scope } = setup(["files.read"], { remote: true });
  writeFileSync(join(checkout, "docs/a.txt"), "remote");
  expect(await dollar.call("files", "read", ["docs/a.txt"], scope)).toEqual({
    content: "remote",
    encoding: "utf8",
    size: 6,
  });
  await expect(
    dollar.call("files", "read", ["leak.txt"], scope),
  ).rejects.toThrow("file read exited 13");
});

test("a write raises file.write from the extension, and a deny gate blocks it", async () => {
  const bus = new ExtensionBus(silentLogger);
  const { dollar, checkout, scope, replace } = setup(["files.write"], {
    host: { bus },
  });
  const seen: Record<string, unknown>[] = [];
  let deny = false;
  bus.add({
    wants: (name) => name === "file.write",
    async dispatch(event) {
      seen.push(event);
      return {
        event,
        gate: deny
          ? { decision: "deny", reason: "read-only checkout" }
          : { decision: "allow" },
      };
    },
  });
  await dollar.call("files", "write", ["docs/ok.txt", "fine"], scope);
  expect(seen[0]).toMatchObject({
    name: "file.write",
    origin: "extension:acme.files",
    op: "upload",
    paths: ["docs/ok.txt"],
    workspace_id: "w1",
    connection: { id: "laptop", generation: 1 },
  });

  deny = true;
  await expect(
    dollar.call("files", "write", ["docs/no.txt", "nope"], scope),
  ).rejects.toThrow("read-only checkout");
  expect(() => readFileSync(join(checkout, "docs/no.txt"))).toThrow();

  // A replaced connection is not written to.
  deny = false;
  replace();
  await expect(
    dollar.call("files", "write", ["docs/late.txt", "x"], scope),
  ).rejects.toMatchObject({ code: EXTENSION_RPC_ERRORS.connectionChanged });
});
