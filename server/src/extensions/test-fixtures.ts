import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../utils/logger";
import type { DollarHost } from "./dollar";
import { ExtensionBus } from "./events";
import { ExtensionHost, type ExtensionHostOptions } from "./host";
import { extensionPaths } from "./paths";
import { ExtensionRegistry } from "./registry";

/** A throwaway data root with linked extensions, for extension tests. */
export function createExtensionSandbox() {
  const root = mkdtempSync(join(tmpdir(), "roamgate-ext-"));
  const paths = extensionPaths(join(root, "data", "extensions"));
  const hosts: ExtensionHost[] = [];

  function link(
    id: string,
    mod: string | null,
    manifest = "",
    registry?: ExtensionRegistry,
  ): string {
    const dir = join(root, "src", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "roamgate-extension.toml"),
      `id = ${JSON.stringify(id)}
name = ${JSON.stringify(id)}
version = "1.0.0"
api = "^1.0"
${mod === null ? "" : 'mod = "./mod.ts"'}
${manifest}
`,
    );
    if (mod !== null) writeFileSync(join(dir, "mod.ts"), mod);
    registry?.add({
      id,
      source: { kind: "link", location: dir },
      version: "1.0.0",
      path: dir,
      enabled: true,
    });
    return dir;
  }

  function registry(options: { safeModeFlag?: boolean } = {}) {
    return new ExtensionRegistry({
      paths,
      appVersion: "0.8.15",
      safeModeFlag: options.safeModeFlag,
    });
  }

  function host(
    reg: ExtensionRegistry,
    options: Omit<Partial<ExtensionHostOptions>, "dollar"> & {
      dollar?: Partial<Omit<DollarHost, "bus">>;
    } = {},
  ) {
    const bus = options.bus ?? new ExtensionBus(silentLogger);
    const created = new ExtensionHost({
      registry: reg,
      paths,
      bus,
      logger: silentLogger,
      ...options,
      dollar: {
        lease: () => null,
        connections: () => [],
        notify: () => undefined,
        toast: () => undefined,
        invalidate: () => undefined,
        ...options.dollar,
      },
    });
    bus.add(created);
    hosts.push(created);
    return { host: created, bus };
  }

  async function cleanup() {
    await Promise.all(hosts.splice(0).map((entry) => entry.dispose()));
    rmSync(root, { recursive: true, force: true });
  }

  return { root, paths, link, registry, host, cleanup };
}
