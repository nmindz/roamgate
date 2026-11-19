import { afterAll, afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookEnvironment } from "./command-hooks";
import {
  extensionConfigReader,
  readExtensionConfig,
  writeExtensionConfig,
} from "./config";
import type { ExtensionInstaller, InstallPreviews } from "./install";
import { createExtensionRpc } from "./rpc";
import { createExtensionSandbox } from "./test-fixtures";

const settingsDir = mkdtempSync(join(tmpdir(), "roamgate-ext-secrets-"));
process.env.ROAMGATE_SETTINGS_PATH = join(settingsDir, "settings.json");
afterAll(() => rmSync(settingsDir, { recursive: true, force: true }));

const sandbox = createExtensionSandbox();
afterEach(() => sandbox.cleanup());

const SECRET = "ghp_synthetic-secret-value-7f3a9c";

const CONFIG = `[config.token]
type = "secret"
title = "Token"
[config.remote_token]
type = "secret"
title = "Remote token"
scope = "connection"
[config.greeting]
type = "string"
title = "Greeting"
default = "hi"
[[commands]]
id = "peek"
title = "Peek"`;

// Replies carry a hash, never the value, so the captured traffic stays clean.
const MOD = `export function register(on) {
  on("command.run", { command: "peek" }, async ($) => {
    const all = await $.config.all();
    let token;
    try {
      token = await $.config.get("token");
    } catch (error) {
      return { all, error: String(error.message) };
    }
    if (typeof token !== "string") return { all, token };
    const leaked = Object.values(process.env).some(
      (value) => typeof value === "string" && value.includes(token),
    );
    return {
      all: { ...all, token: typeof all.token },
      token_sha256: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      in_env: leaked,
    };
  });
  on("ui.render", { slot: "statusbar.item" }, async ($) => {
    const all = await $.config.all();
    await $.ui.toast({ message: JSON.stringify(all) });
    return { text: JSON.stringify(all), tone: "info" };
  });
}`;

function setup() {
  const registry = sandbox.registry();
  sandbox.link(
    "acme.plain",
    MOD,
    `capabilities = ["ui", "commands"]
activation = ["slot:statusbar.item"]
${CONFIG}`,
    registry,
  );
  sandbox.link(
    "acme.keyed",
    MOD,
    `capabilities = ["commands", "secrets"]
${CONFIG}`,
    registry,
  );
  const traffic: string[] = [];
  const readConfig = extensionConfigReader(registry, sandbox.paths);
  const { host } = sandbox.host(registry, {
    readConfig,
    dollar: {
      toast: (ext, toast) =>
        traffic.push(JSON.stringify({ extensions: { toast: { ext, toast } } })),
      invalidate: (ext, slot) =>
        traffic.push(
          JSON.stringify({ extensions: { invalidate: { ext, slot } } }),
        ),
    },
  });
  const rpc = createExtensionRpc({
    registry,
    host,
    installer: {} as ExtensionInstaller,
    previews: {} as InstallPreviews,
    broadcast: (push) => traffic.push(JSON.stringify({ extensions: push })),
    paths: sandbox.paths,
  });
  host.onChange(() => rpc.publishState());
  host.start();
  // A leak through an RPC reply is as bad as one through a push.
  const call = async (method: string, params: Record<string, unknown>) => {
    const result = await rpc.handle(method, params);
    traffic.push(JSON.stringify({ result }));
    return result as Record<string, unknown>;
  };
  return { registry, host, rpc, call, traffic, readConfig };
}

test("AC-01-31: secrets stay out of browser payloads and reach $.config only with `secrets`", async () => {
  const { registry, call, traffic, readConfig } = setup();

  for (const ext of ["acme.plain", "acme.keyed"])
    expect(
      await call("ext.config.set", { ext, key: "token", value: SECRET }),
    ).toEqual({ ok: true });

  const file = sandbox.paths.secretsFile("acme.plain");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: SECRET });
  if (process.platform !== "win32")
    expect(statSync(file).mode & 0o777).toBe(0o600);
  // Atomic replace leaves no temporary files behind.
  expect(readdirSync(sandbox.paths.dataDir("acme.plain"))).toEqual([
    "secrets.json",
  ]);
  // Secrets never land in settings.json.
  const settings = Bun.file(process.env.ROAMGATE_SETTINGS_PATH!);
  if (await settings.exists())
    expect(await settings.text()).not.toContain(SECRET);

  const got = await call("ext.config.get", { ext: "acme.plain" });
  expect(got.values).toEqual({
    token: { set: true },
    remote_token: { set: false },
    greeting: "hi",
  });

  // Without `secrets` the mod sees only the marker; get is refused.
  const plain = (await call("ext.command.run", {
    ext: "acme.plain",
    command: "peek",
  })) as { result: Record<string, unknown> };
  expect(plain.result).toEqual({
    all: { token: { set: true }, remote_token: { set: false }, greeting: "hi" },
    error: expect.stringContaining('needs the "secrets" capability'),
  });
  // With `secrets` it reads the value; its process environment never has it.
  const keyed = (await call("ext.command.run", {
    ext: "acme.keyed",
    command: "peek",
  })) as { result: Record<string, unknown> };
  expect(keyed.result).toEqual({
    all: { token: "string", remote_token: null, greeting: "hi" },
    token_sha256: new Bun.CryptoHasher("sha256").update(SECRET).digest("hex"),
    in_env: false,
  });

  // init carries the same view the mod gets through `$.config`.
  expect((await readConfig("acme.plain")).token).toEqual({ set: true });
  expect((await readConfig("acme.keyed")).token).toBe(SECRET);

  await call("ext.ui.render", { slot: "statusbar.item", context: {} });
  await call("ext.state", {});
  expect(traffic.some((line) => line.includes('"toast"'))).toBe(true);
  expect(traffic.some((line) => line.includes('"state"'))).toBe(true);
  for (const line of traffic) expect(line).not.toContain(SECRET);

  const manifest = registry.validate(registry.get("acme.plain")!).manifest!;
  expect(
    JSON.stringify(
      hookEnvironment(
        {
          ext: "acme.plain",
          root: registry.get("acme.plain")!.path,
          data: sandbox.paths.dataDir("acme.plain"),
        },
        { name: "pane.close", at: 1 },
      ),
    ),
  ).not.toContain(SECRET);
  expect(JSON.stringify(manifest)).not.toContain(SECRET);
});

test("connection-scoped secrets and null clearing", async () => {
  const { call } = setup();
  await call("ext.config.set", {
    ext: "acme.plain",
    key: "remote_token",
    value: SECRET,
    connection_id: "remote-a",
  });
  expect(
    JSON.parse(readFileSync(sandbox.paths.secretsFile("acme.plain"), "utf8")),
  ).toEqual({ "connection:remote-a:remote_token": SECRET });
  const forA = await call("ext.config.get", {
    ext: "acme.plain",
    connection_id: "remote-a",
  });
  expect((forA.values as Record<string, unknown>).remote_token).toEqual({
    set: true,
  });
  const forDefault = await call("ext.config.get", { ext: "acme.plain" });
  expect((forDefault.values as Record<string, unknown>).remote_token).toEqual({
    set: false,
  });

  await call("ext.config.set", {
    ext: "acme.plain",
    key: "remote_token",
    value: null,
    connection_id: "remote-a",
  });
  expect(
    JSON.parse(readFileSync(sandbox.paths.secretsFile("acme.plain"), "utf8")),
  ).toEqual({});
  await expect(
    call("ext.config.set", { ext: "acme.plain", key: "token", value: 42 }),
  ).rejects.toThrow("must be text");
});

test("readExtensionConfig masks secrets unless asked to reveal them", async () => {
  const { registry } = setup();
  const manifest = registry.validate(registry.get("acme.keyed")!).manifest!;
  await writeExtensionConfig(
    manifest,
    "token",
    SECRET,
    undefined,
    sandbox.paths,
  );
  expect(
    (await readExtensionConfig(manifest, undefined, { paths: sandbox.paths }))
      .token,
  ).toEqual({ set: true });
  expect(
    (
      await readExtensionConfig(manifest, undefined, {
        paths: sandbox.paths,
        revealSecrets: true,
      })
    ).token,
  ).toBe(SECRET);
});
