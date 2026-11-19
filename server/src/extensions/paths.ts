import { join } from "node:path";
import { EXTENSION_ID_PATTERN } from "../../../shared/extensions";
import { dataRoot } from "../config/data-paths";

/** Layout of `<data root>/extensions`; every file goes through the data-path helpers. */
export interface ExtensionPaths {
  root: string;
  registry: string;
  versions: string;
  links: string;
  marketplaces: string;
  marketplacesFile: string;
  receipts: string;
  versionDir(id: string, version: string): string;
  dataDir(id: string): string;
  storeFile(id: string): string;
  secretsFile(id: string): string;
  logsDir(id: string): string;
}

function checkedId(id: string): string {
  if (!EXTENSION_ID_PATTERN.test(id) || id === "." || id === "..")
    throw new Error(`invalid extension id: ${JSON.stringify(id)}`);
  return id;
}

export function extensionPaths(
  root = join(dataRoot(), "extensions"),
): ExtensionPaths {
  return {
    root,
    registry: join(root, "registry.json"),
    versions: join(root, "versions"),
    links: join(root, "links"),
    marketplaces: join(root, "marketplaces"),
    marketplacesFile: join(root, "marketplaces.json"),
    receipts: join(root, "receipts.sqlite"),
    versionDir: (id, version) => join(root, "versions", checkedId(id), version),
    dataDir: (id) => join(root, "data", checkedId(id)),
    storeFile: (id) => join(root, "data", checkedId(id), "store.json"),
    secretsFile: (id) => join(root, "data", checkedId(id), "secrets.json"),
    logsDir: (id) => join(root, "data", checkedId(id), "logs"),
  };
}
