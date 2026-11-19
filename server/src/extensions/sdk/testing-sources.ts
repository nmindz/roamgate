import { readSource } from "./read-source" with { type: "macro" };

/** Repository-relative path of the `bun test` preload among the sources. */
export const TESTING_PRELOAD = "server/src/extensions/sdk/testing-preload.ts";

/**
 * The fake host and every module it imports, by repository-relative path. A
 * compiled binary has no sources on disk, so `roamgate ext test` writes
 * these out. Text imports cannot be used: the bundler would merge them with
 * the normal imports of the same files.
 */
export const TESTING_SOURCES: Readonly<Record<string, string>> = {
  "shared/extensions.ts": readSource("../../../../shared/extensions.ts"),
  "shared/shortcuts.ts": readSource("../../../../shared/shortcuts.ts"),
  "server/src/extensions/analyze.ts": readSource("../analyze.ts"),
  "server/src/extensions/guard.ts": readSource("../guard.ts"),
  "server/src/extensions/keybindings.ts": readSource("../keybindings.ts"),
  "server/src/extensions/manifest.ts": readSource("../manifest.ts"),
  "server/src/extensions/protocol.ts": readSource("../protocol.ts"),
  "server/src/extensions/sdk/runtime.ts": readSource("./runtime.ts"),
  "server/src/extensions/sdk/testing.ts": readSource("./testing.ts"),
  [TESTING_PRELOAD]: readSource("./testing-preload.ts"),
};
