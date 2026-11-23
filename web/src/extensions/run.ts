import { bridge } from "../api";
import { store } from "../store";
import { openCommandAnswer } from "./openPage";

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

/**
 * `ext.command.run` for an extension command id. An `{ open }` answer naming
 * the extension's own `/ext/<id>/web/` page opens it over the workspace.
 */
export async function runCommand(
  ctx: Pick<RunContext, "ext" | "context">,
  command: string,
) {
  const result = await bridge.call("ext.command.run", {
    ext: ctx.ext,
    command,
    context: ctx.context,
  });
  // Callers still get the raw reply; only an own-page `open` has a side effect.
  openCommandAnswer(ctx.ext, (result as { result?: unknown } | null)?.result);
  return result;
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
