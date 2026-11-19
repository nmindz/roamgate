import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Bun macro (`with { type: "macro" }`): returns a file's text, relative to
 * this directory, inlined at bundle time so compiled binaries carry it.
 */
export function readSource(path: string): string {
  return readFileSync(join(import.meta.dir, path), "utf8");
}
