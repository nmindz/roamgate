import { useSyncExternalStore } from "react";
import { addListener } from "../../../shared/listeners";

// A command may answer `{ open: "/ext/<own-id>/web/..." }` to show that
// extension's proxied web page. Anything outside its own prefix is ignored.

export interface OpenExtensionPage {
  ext: string;
  url: string;
}

/** The same-origin path a command answer may open, or null when it may not. */
export function commandOpenPath(ext: string, answer: unknown): string | null {
  const open = (answer as { open?: unknown } | null)?.open;
  if (typeof open !== "string" || !open.startsWith("/")) return null;
  const prefix = `/ext/${encodeURIComponent(ext)}/web/`;
  let url: URL;
  try {
    url = new URL(open, "http://host.invalid");
  } catch {
    return null;
  }
  // Rejects `//other`, `\` tricks and `..` escapes: the normalised path must
  // still sit under the prefix, and nothing may target the capability frame.
  if (url.origin !== "http://host.invalid") return null;
  if (!url.pathname.startsWith(prefix)) return null;
  if (url.pathname.slice(prefix.length).startsWith("_/")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

let current: OpenExtensionPage | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => addListener(listeners, listener);
const get = () => current;

export function setOpenExtensionPage(next: OpenExtensionPage | null) {
  current = next;
  listeners.forEach((listener) => listener());
}

/** Opens the page a command answered with, if it is the extension's own. */
export function openCommandAnswer(ext: string, answer: unknown) {
  const url = commandOpenPath(ext, answer);
  if (url) setOpenExtensionPage({ ext, url });
  return url;
}

export const useOpenExtensionPage = () =>
  useSyncExternalStore(subscribe, get, get);
