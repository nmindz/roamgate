import { useSyncExternalStore } from "react";
import type { ExtensionStateResult } from "../../../shared/extensions";
import { addListener } from "../../../shared/listeners";
import { bridge } from "../api";

// The chunk's own mirror of `ext.state`, independent of the eager gate so the
// Extensions tab works with zero extensions installed.

let state: ExtensionStateResult | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

export const getExtensionsState = () => state;

export function setExtensionsState(next: ExtensionStateResult | null) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function isExtensionState(
  value: unknown,
): value is ExtensionStateResult {
  return Array.isArray((value as ExtensionStateResult | null)?.extensions);
}

function refresh() {
  const before = state;
  bridge.call("ext.state").then(
    (result) => {
      // A push that landed meanwhile is newer than this reply.
      if (state === before && isExtensionState(result))
        setExtensionsState(result);
    },
    // Older servers reject ext.*: show the tab as unavailable, not as empty.
    () => state === before && setExtensionsState(null),
  );
}

/** Starts the mirror once: fetch on every connect, replace on every state push. */
export function startExtensionsMirror() {
  if (stop) return;
  const offs = [
    bridge.onExtensions((push) => {
      if ("state" in push && isExtensionState(push.state))
        setExtensionsState(push.state);
    }),
    bridge.onStatus((status) => status === "connected" && refresh()),
  ];
  stop = () => offs.forEach((off) => off());
}

/** Detaches the mirror and forgets its state; the next hook use restarts it. */
export function resetExtensionsMirror() {
  stop?.();
  stop = null;
  setExtensionsState(null);
}

export function useExtensionsState() {
  startExtensionsMirror();
  return useSyncExternalStore(
    (listener) => addListener(listeners, listener),
    getExtensionsState,
  );
}
