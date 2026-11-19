import { bridge } from "../api";
import { store } from "../store";

export interface RunContext {
  ext: string;
  slot: string;
  entryId: string;
  context: Record<string, unknown>;
}

/** `ext.ui.action`: an element id and its value, with the viewer's slot context. */
export function runUiAction(
  ctx: RunContext,
  elementId: string,
  value: unknown,
) {
  return bridge.call("ext.ui.action", {
    ext: ctx.ext,
    slot: ctx.slot,
    entry_id: ctx.entryId,
    element_id: elementId,
    value,
    context: ctx.context,
  });
}

/** `ext.command.run` for an extension command id. */
export function runCommand(
  ctx: Pick<RunContext, "ext" | "context">,
  command: string,
) {
  return bridge.call("ext.command.run", {
    ext: ctx.ext,
    command,
    context: ctx.context,
  });
}

/** Runs a command from a menu or badge; failures surface as a notice. */
export function runCommandNotify(
  ctx: Pick<RunContext, "ext" | "context">,
  command: string,
  name: string,
) {
  return runCommand(ctx, command).catch((error: unknown) =>
    store.notify({
      kind: "error",
      message: `${name}: command failed`,
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
}
