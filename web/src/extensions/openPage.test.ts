import { afterEach, describe, expect, test } from "bun:test";
import {
  commandOpenPath,
  openCommandAnswer,
  setOpenExtensionPage,
} from "./openPage";

afterEach(() => setOpenExtensionPage(null));

describe("command open answers", () => {
  test("opens the extension's own proxied page with its query", () => {
    expect(
      commandOpenPath("acme.app", { open: "/ext/acme.app/web/?cwd=%2Fw#top" }),
    ).toBe("/ext/acme.app/web/?cwd=%2Fw#top");
    expect(commandOpenPath("acme.app", { open: "/ext/acme.app/web/x/y" })).toBe(
      "/ext/acme.app/web/x/y",
    );
  });

  test.each([
    ["another extension", "/ext/other/web/"],
    ["a prefix lookalike", "/ext/acme.application/web/"],
    ["a dot-dot escape", "/ext/acme.app/web/../../api/x"],
    ["an encoded escape", "/ext/acme.app/web/%2e%2e/%2e%2e/api"],
    ["the capability frame", "/ext/acme.app/web/_/123.sig/"],
    ["another origin", "//evil.example/ext/acme.app/web/"],
    ["a backslash origin", "/\\evil.example/ext/acme.app/web/"],
    ["an absolute URL", "https://evil.example/ext/acme.app/web/"],
    ["a script URL", "javascript:alert(1)"],
    ["the frame assets", "/ext/acme.app/frame/x.html"],
  ])("ignores %s", (_name, open) => {
    expect(commandOpenPath("acme.app", { open })).toBeNull();
  });

  test("ignores answers without a string open", () => {
    for (const answer of [null, undefined, "x", 1, {}, { open: 1 }])
      expect(commandOpenPath("acme.app", answer)).toBeNull();
  });

  test("only an own page becomes the open page", () => {
    expect(openCommandAnswer("acme.app", { open: "/ext/other/web/" })).toBe(
      null,
    );
    expect(openCommandAnswer("acme.app", { open: "/ext/acme.app/web/" })).toBe(
      "/ext/acme.app/web/",
    );
  });
});
