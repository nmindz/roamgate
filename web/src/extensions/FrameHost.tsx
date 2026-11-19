import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../api";
import { useLayoutPreferences } from "../layoutPreferences";
import {
  FRAME_STYLE_VARIABLES,
  FrameBridge,
  type FrameHostContext,
} from "./frameBridge";
import { useExtensionsState } from "./state";

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 40;
const MAX_HEIGHT = 4000;
/** Theme changes reach the frame well inside the 250 ms the contract allows. */
const THEME_DEBOUNCE_MS = 80;

function inset(name: string): number {
  const probe = document.documentElement.style.getPropertyValue(name);
  const value = Number.parseFloat(probe);
  return Number.isFinite(value) ? value : 0;
}

export function readHostContext(
  mobile: boolean,
  size: { width: number; height: number },
): FrameHostContext {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const name of FRAME_STYLE_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  }
  return {
    theme: root.dataset.theme ?? "dark",
    accent: root.dataset.accent ?? "",
    styles: { variables },
    mobile,
    size,
    safeAreaInsets: {
      top: inset("--safe-area-top"),
      right: inset("--safe-area-right"),
      bottom: inset("--safe-area-bottom"),
      left: inset("--safe-area-left"),
    },
  };
}

/** `/ext/<id>/frame/<entry>` for a declared frame, or null for an unknown one. */
export function frameSource(ext: string, entry: string): string {
  const path = entry
    .replace(/^\.\//, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/ext/${encodeURIComponent(ext)}/frame/${path}`;
}

export interface FramePayload {
  name: string;
  data: unknown;
}

/**
 * An extension frame in an opaque-origin sandbox. The frame never holds
 * credentials: its calls go through this host and the authenticated socket.
 */
export function FrameHost({
  ext,
  frame,
  height,
  payload,
}: {
  ext: string;
  frame: string;
  height?: number;
  /** Sent through the bridge once the frame initialized, and again on change. */
  payload?: FramePayload;
}) {
  const state = useExtensionsState();
  const { mobile } = useLayoutPreferences();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<FrameBridge | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const declared = state?.extensions
    .find((entry) => entry.id === ext)
    ?.contributions.frames?.find((item) => item.id === frame);
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;

  useEffect(() => {
    if (!declared) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const rect = () => ({
      width: iframe.clientWidth || window.innerWidth,
      height: iframe.clientHeight || DEFAULT_HEIGHT,
    });
    const frameBridge = new FrameBridge({
      frameWindow: () => iframe.contentWindow,
      // Opaque origin: no origin can be named, and nothing secret is sent.
      post: (message) => iframe.contentWindow?.postMessage(message, "*"),
      hostContext: () => readHostContext(mobileRef.current, rect()),
      call: (method, params) =>
        bridge.call("ext.frame.call", { ext, frame, method, params }),
      openLink: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      onSize: (next) =>
        setSize(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(next)))),
    });
    bridgeRef.current = frameBridge;
    const onMessage = (event: MessageEvent) => {
      frameBridge.handle(event);
      if (frameBridge.ready) setReady(true);
    };
    window.addEventListener("message", onMessage);
    const offPush = bridge.onExtensions((push) => {
      if (!("frame_event" in push)) return;
      const event = push.frame_event;
      if (event.ext === ext && (!event.frame || event.frame === frame))
        frameBridge.event(event.name, event.data);
    });
    let timer: number | undefined;
    const changed = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => frameBridge.hostContextChanged(),
        THEME_DEBOUNCE_MS,
      );
    };
    const observer = new MutationObserver(changed);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent", "style", "class"],
    });
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      offPush();
      window.removeEventListener("message", onMessage);
      frameBridge.teardown();
      bridgeRef.current = null;
      setReady(false);
    };
  }, [declared?.entry, ext, frame]);

  useEffect(() => {
    bridgeRef.current?.hostContextChanged();
  }, [mobile]);

  useEffect(() => {
    if (ready && payload) bridgeRef.current?.event(payload.name, payload.data);
  }, [ready, payload]);

  const src = useMemo(
    () => (declared ? frameSource(ext, declared.entry) : null),
    [declared?.entry, ext],
  );
  if (!src)
    return (
      <p className="ext-error" role="alert">
        Frame {frame} is not declared by {ext}.
      </p>
    );
  return (
    <iframe
      ref={iframeRef}
      className="ext-frame"
      title={`${ext}: ${frame}`}
      sandbox="allow-scripts"
      src={src}
      referrerPolicy="no-referrer"
      style={{ height: size ?? height ?? declared?.height ?? DEFAULT_HEIGHT }}
    />
  );
}
