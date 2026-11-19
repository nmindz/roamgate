import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { plugin } from "bun";

/** `bun test --preload` this file so extension tests can import `roamgate:testing`. */
plugin({
  name: "roamgate:testing",
  setup(build) {
    const fakeHost = pathToFileURL(join(import.meta.dir, "testing.ts")).href;
    build.module("roamgate:testing", () => ({
      contents: `export * from ${JSON.stringify(fakeHost)};`,
      loader: "ts",
    }));
  },
});
