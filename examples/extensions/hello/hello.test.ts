// Run with `roamgate ext test examples/extensions/hello`.
import { afterEach, expect, test } from "bun:test";
import { createFakeHost, type FakeHost } from "roamgate:testing";

let host: FakeHost | undefined;
afterEach(() => host?.close());

test("say-hi counts greetings, toasts and refreshes the status bar", async () => {
  host = await createFakeHost({
    dir: import.meta.dir,
    config: { greeting: "Hello" },
  });
  expect(await host.command("say-hi")).toEqual({ greetings: 1 });
  expect(await host.command("say-hi")).toEqual({ greetings: 2 });
  expect(host.store.get("greetings")).toBe(2);
  expect(host.toasts.at(-1)).toEqual({
    kind: "success",
    message: "Hello! (#2)",
  });
  expect(host.invalidations).toEqual(["statusbar.item", "statusbar.item"]);
  expect(await host.render("statusbar.item")).toMatchObject({
    text: "2 greetings",
    command: "say-hi",
  });
});

test("the status bar starts from the stored count", async () => {
  host = await createFakeHost({
    dir: import.meta.dir,
    store: { greetings: 1 },
  });
  expect(await host.render("statusbar.item")).toMatchObject({
    text: "1 greeting",
  });
});
