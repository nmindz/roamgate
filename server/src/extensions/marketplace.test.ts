import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MARKETPLACE_CATALOG_FILE,
  type MarketplaceBrowseEntry,
} from "../../../shared/extensions";
import { createExtCommand } from "../cli/ext";
import { createTestCli } from "../cli/test-context";
import { ExtensionInstaller, InstallPreviews } from "./install";
import { MarketplaceStore, parseMarketplaceCatalog } from "./marketplace";
import { createExtensionRpc, type ExtensionRpc } from "./rpc";
import { createExtensionSandbox } from "./test-fixtures";

let sandbox = createExtensionSandbox();
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
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

function repo(name: string) {
  const dir = join(sandbox.root, "repos", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "-b", "main");
  const commit = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files))
      writeFileSync(join(dir, file), text);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "update");
    return git(dir, "rev-parse", "HEAD");
  };
  return { dir, url: pathToFileURL(dir).href, commit };
}

function extensionFiles(version: string) {
  return {
    "roamgate-extension.toml": `id = "acme.hello"\nname = "Hello"\nversion = "${version}"\napi = "^1.0"\nmod = "./mod.ts"\ncapabilities = ["ui"]\n`,
    "mod.ts": `export function register(on, $) {\n  on("agent.status", async ($) => { await $.ui.toast({ message: "${version}" }); });\n}\n`,
  };
}

function catalogFile(source: string, ref: string, version: string) {
  return {
    [MARKETPLACE_CATALOG_FILE]: JSON.stringify({
      name: "acme",
      description: "Acme extensions",
      extensions: [
        {
          id: "acme.hello",
          name: "Hello",
          description: "Says hello",
          version,
          source,
          ref,
          tags: ["demo"],
        },
      ],
    }),
  };
}

function services() {
  const registry = sandbox.registry();
  const { host } = sandbox.host(registry);
  host.start();
  const installer = new ExtensionInstaller({
    paths: sandbox.paths,
    registry,
    appVersion: "1.2.3",
  });
  const previews = new InstallPreviews(installer);
  cleanups.push(() => previews.clear());
  const marketplaces = new MarketplaceStore({ paths: sandbox.paths });
  const rpc = createExtensionRpc({
    registry,
    host,
    installer,
    previews,
    broadcast: () => undefined,
    marketplaces,
  });
  return { registry, rpc, marketplaces };
}

function cli() {
  const test = createTestCli();
  cleanups.push(test.cleanup);
  const command = createExtCommand({
    probe: async () => false,
    confirm: async () => false,
    strictValidation: () => false,
    paths: () => sandbox.paths,
  });
  return {
    test,
    run: (...args: string[]) => command.run(args, test.context),
  };
}
async function browseEntries(
  rpc: ExtensionRpc,
): Promise<MarketplaceBrowseEntry[]> {
  // `handle` returns unknown; the browse method's shape is fixed by the contract.
  const result = (await rpc.handle("ext.marketplace.browse", {})) as {
    entries: MarketplaceBrowseEntry[];
  };
  return result.entries;
}

test("a catalog pin installs exactly that commit after consent; refresh installs nothing until update", async () => {
  const extension = repo("hello");
  const pinned = extension.commit(extensionFiles("1.0.0"));
  // The branch moves on before the install; the pin must still win.
  const newer = extension.commit(extensionFiles("1.1.0"));
  const catalogRepo = repo("catalog");
  catalogRepo.commit(catalogFile(extension.url, pinned, "1.0.0"));

  const { registry, rpc } = services();
  const added = (await rpc.handle("ext.marketplace.add", {
    source: catalogRepo.url,
  })) as { marketplace: { name: string; entries: number; kind: string } };
  expect(added.marketplace).toMatchObject({
    name: "acme",
    entries: 1,
    kind: "git",
  });
  expect(registry.records()).toEqual([]);

  const browse = () => browseEntries(rpc);
  const [entry] = await browse();
  expect(entry).toMatchObject({
    marketplace: "acme",
    id: "acme.hello",
    install: { source: extension.url, ref: pinned },
    installed: null,
  });

  // The consent screen: a summary naming the pinned commit, nothing installed yet.
  const preview = (await rpc.handle("ext.install.preview", entry!.install)) as {
    preview_id: string;
    summary: { id: string; version: string; capabilities: unknown[] };
  };
  expect(preview.summary).toMatchObject({ id: "acme.hello", version: "1.0.0" });
  expect(JSON.stringify(preview.summary)).toContain(pinned);
  expect(registry.records()).toEqual([]);

  const applied = (await rpc.handle("ext.install.apply", {
    preview_id: preview.preview_id,
  })) as { record: { source: { resolved: string; ref: string } } };
  expect(applied.record.source).toMatchObject({
    resolved: pinned,
    ref: pinned,
  });
  const installed = registry.get("acme.hello")!;
  expect(installed.version).toBe("1.0.0");
  expect((await browse())[0]!.installed).toMatchObject({
    version: "1.0.0",
    resolved: pinned,
    pinned: true,
    update_available: false,
  });

  // The catalog now lists the newer version; refreshing only re-reads it.
  catalogRepo.commit(catalogFile(extension.url, newer, "1.1.0"));
  const versionsDir = join(sandbox.paths.versions, "acme.hello");
  const versionsBefore = readdirSync(versionsDir);
  const refreshed = (await rpc.handle("ext.marketplace.refresh", {})) as {
    marketplaces: unknown[];
    errors: unknown[];
  };
  expect(refreshed.errors).toEqual([]);
  expect(refreshed.marketplaces).toHaveLength(1);
  const afterRefresh = sandbox.registry().get("acme.hello")!;
  expect(afterRefresh.version).toBe("1.0.0");
  expect(afterRefresh.source.resolved).toBe(pinned);
  expect(afterRefresh.path).toBe(installed.path);
  expect(readdirSync(versionsDir)).toEqual(versionsBefore);
  expect((await browse())[0]).toMatchObject({
    version: "1.1.0",
    install: { ref: newer },
    installed: { version: "1.0.0", pinned: false, update_available: true },
  });

  // `update` follows the catalog's new pin.
  const { test: cliTest, run } = cli();
  expect(await run("update", "acme.hello", "--yes")).toBe(0);
  expect(cliTest.output.join("\n")).toContain(
    `acme.hello: installed 1.0.0 (${pinned}), available 1.1.0 (${newer})`,
  );
  const updated = sandbox.registry().get("acme.hello")!;
  expect(updated.version).toBe("1.1.0");
  expect(updated.source.resolved).toBe(newer);
});

test("a pinned commit that is no longer in the repository fails instead of installing what the branch moved to", async () => {
  const extension = repo("hello");
  extension.commit(extensionFiles("1.0.0"));
  const pinned = extension.commit(extensionFiles("1.1.0"));
  // Pruned so even a file:// clone cannot fetch the dropped commit.
  git(extension.dir, "reset", "--quiet", "--hard", "HEAD~1");
  git(extension.dir, "reflog", "expire", "--expire=now", "--all");
  git(extension.dir, "gc", "--quiet", "--prune=now");
  const catalogRepo = repo("catalog");
  catalogRepo.commit(catalogFile(extension.url, pinned, "1.1.0"));

  const { registry, rpc } = services();
  await rpc.handle("ext.marketplace.add", { source: catalogRepo.url });
  const [entry] = await browseEntries(rpc);
  await expect(
    rpc.handle("ext.install.preview", entry!.install),
  ).rejects.toThrow(/git checkout failed/);
  expect(registry.records()).toEqual([]);
});

test("marketplace CLI adds, lists, refreshes and removes a file catalog without installing anything", async () => {
  const extension = repo("hello");
  const pinned = extension.commit(extensionFiles("1.0.0"));
  const newer = extension.commit(extensionFiles("1.1.0"));
  const catalogDir = join(sandbox.root, "catalog");
  mkdirSync(catalogDir);
  const catalogPath = join(catalogDir, MARKETPLACE_CATALOG_FILE);
  writeFileSync(
    catalogPath,
    catalogFile(extension.url, pinned, "1.0.0")[MARKETPLACE_CATALOG_FILE]!,
  );
  const { test: cliTest, run } = cli();

  expect(await run("marketplace", "add", catalogDir)).toBe(0);
  expect(cliTest.output.at(-1)).toBe(
    "Added marketplace acme (1 extensions). Nothing was installed.",
  );
  await expect(run("marketplace", "add", catalogDir)).rejects.toThrow(
    /already added/,
  );

  expect(await run("marketplace", "list")).toBe(0);
  expect(cliTest.output.at(-1)).toBe(
    `    roamgate ext install ${extension.url} --ref ${pinned}`,
  );

  writeFileSync(
    catalogPath,
    catalogFile(extension.url, newer, "1.1.0")[MARKETPLACE_CATALOG_FILE]!,
  );
  expect(await run("marketplace", "refresh", "--json")).toBe(0);
  const refreshed = JSON.parse(cliTest.output.at(-1)!);
  expect(refreshed.errors).toEqual([]);
  expect(refreshed.marketplaces).toMatchObject([
    { name: "acme", kind: "file", entries: 1 },
  ]);
  expect(sandbox.registry().records()).toEqual([]);

  expect(await run("marketplace", "list", "--json")).toBe(0);
  const listed = JSON.parse(cliTest.output.at(-1)!);
  expect(listed.marketplaces[0].extensions[0]).toMatchObject({
    id: "acme.hello",
    version: "1.1.0",
    ref: newer,
  });

  writeFileSync(catalogPath, "{ not json");
  expect(await run("marketplace", "refresh", "acme")).toBe(1);
  expect(cliTest.errors.at(-1)).toBe(
    `acme: ${MARKETPLACE_CATALOG_FILE} is not valid JSON`,
  );
  expect(
    new MarketplaceStore({ paths: sandbox.paths }).catalog("acme"),
  ).not.toBeNull();

  expect(await run("marketplace", "remove", "acme")).toBe(0);
  expect(await run("marketplace", "list")).toBe(0);
  expect(cliTest.output.at(-1)).toBe("No marketplaces added.");
});

test("catalog entries must pin with the right kind of digest", () => {
  const parse = (entry: Record<string, unknown>) =>
    parseMarketplaceCatalog(
      JSON.stringify({
        name: "acme",
        extensions: [{ id: "acme.x", source: "acme/x", ...entry }],
      }),
    );
  expect(parse({}).extensions[0]).toEqual({
    id: "acme.x",
    name: "acme.x",
    description: "",
    source: "acme/x",
    tags: [],
  });
  expect(() => parse({ ref: "main" })).toThrow(/40-hex commit SHA/);
  expect(() => parse({ sha256: "a".repeat(64) })).toThrow(/pin with ref/);
  expect(() => parse({ source: "https://example.com/x.tar.gz" })).toThrow(
    /--sha256/,
  );
  expect(() =>
    parse({ source: "https://example.com/x.tar.gz", ref: "a".repeat(40) }),
  ).toThrow(/sha256/);
  expect(() =>
    parseMarketplaceCatalog(
      JSON.stringify({
        name: "acme",
        extensions: [
          { id: "acme.x", source: "acme/x" },
          { id: "acme.x", source: "acme/y" },
        ],
      }),
    ),
  ).toThrow(/more than once/);
  expect(() =>
    parseMarketplaceCatalog(JSON.stringify({ name: "../x", extensions: [] })),
  ).toThrow(/catalog name/);
});
