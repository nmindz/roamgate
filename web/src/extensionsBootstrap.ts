// Eager side of extensions: kept tiny; everything else is in the lazy chunk.
import { createElement, Suspense, useSyncExternalStore } from "react";
import type { ExtensionStateResult } from "../../shared/extensions";
import { addListener } from "../../shared/listeners";
import { type Bridge, bridge } from "./api";
import { roamgateLocalStorage } from "./browserStorage";
import type { HostProps } from "./extensions/types";
import { lazyWithReload } from "./lazyWithReload";
import type { CustomTerminalTheme } from "./terminalThemes";

export interface LinkPattern {
  ext: string;
  regex: RegExp;
  /** `{0}` is the whole match, `{1}` the first group. */
  url: string;
}

export interface FilePreviewer {
  ext: string;
  frame: string;
  extensions: string[];
}

/** What enabled extensions contribute without running code. */
interface Contributions {
  terminalThemes: readonly CustomTerminalTheme[];
  linkPatterns: readonly LinkPattern[];
  previewers: readonly FilePreviewer[];
}

/** True for an enabled extension, or one auto-disabled that the chunk must explain. */
export const needsExtensionsChunk = (state: unknown) =>
  !!(state as ExtensionStateResult | null)?.extensions?.some(
    (entry) => entry.enabled || entry.status === "failed",
  );

// The gate is null until the first ext.state answer, so callers can tell
// "none" from "unknown". Both values share one subscription set to stay small.
let gate: boolean | null = null;
let contributions: Contributions = {
  terminalThemes: [],
  linkPatterns: [],
  previewers: [],
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => addListener(listeners, listener);

export const extensionsGateOpen = () => gate;
export const getExtensionContributions = () => contributions;

export function syncExtensionsGate(state: unknown) {
  const next =
    needsExtensionsChunk(state) ||
    roamgateLocalStorage.getItem("dynamicShortcuts.v1") !== null;
  if (next === gate) return;
  gate = next;
  listeners.forEach((listener) => listener());
}

export function setExtensionContributions(next: Partial<Contributions>) {
  contributions = { ...contributions, ...next };
  listeners.forEach((listener) => listener());
}

const useStore = <T>(get: () => T) => useSyncExternalStore(subscribe, get, get);
export const useExtensionsGate = () => useStore(extensionsGateOpen);
export const useExtensionContributions = () =>
  useStore(getExtensionContributions);

export function initExtensionsGate(
  source: Pick<Bridge, "call" | "onExtensions" | "onStatus">,
) {
  source.onExtensions(
    (push) => "state" in push && syncExtensionsGate(push.state),
  );
  source.onStatus(
    (status) =>
      status === "connected" &&
      source
        .call("ext.state")
        .then(syncExtensionsGate, () => syncExtensionsGate(null)),
  );
}

initExtensionsGate(bridge);

const ExtensionsHost = lazyWithReload(
  "extensions",
  () => import("./extensions"),
);

/** Renders nothing until an extension needs the chunk, and never loads it needlessly. */
export function ExtensionSlot(props: HostProps) {
  const open = useExtensionsGate();
  // The palette lists Herdr plugin actions with or without any extension.
  const shown = open || props.slot === "command";
  return shown
    ? createElement(
        Suspense,
        { fallback: null },
        createElement(ExtensionsHost, props),
      )
    : null;
}
