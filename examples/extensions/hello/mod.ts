// Reference extension. `$` reaches Roamgate; `$.store` survives restarts,
// updates and live reloads of a linked directory. Types come from the
// roamgate.d.ts that `roamgate ext types` writes.
import type { Dollar, On } from "roamgate";

async function greetings($: Dollar): Promise<number> {
  const count = await $.store.get("greetings");
  return typeof count === "number" ? count : 0;
}

export function register(on: On) {
  on("command.run", { command: "say-hi" }, async ($) => {
    const greeting = (await $.config.get("greeting")) ?? "Hi";
    const count = (await greetings($)) + 1;
    await $.store.set("greetings", count);
    await $.ui.toast({ kind: "success", message: `${greeting}! (#${count})` });
    await $.ui.invalidate("statusbar.item");
    return { greetings: count };
  });

  on("ui.render", { slot: "statusbar.item" }, async ($) => {
    const count = await greetings($);
    return {
      text: count === 1 ? "1 greeting" : `${count} greetings`,
      tone: "info",
      icon: "hand",
      tooltip: "Run Hello: Say hi",
      command: "say-hi",
    };
  });
}
