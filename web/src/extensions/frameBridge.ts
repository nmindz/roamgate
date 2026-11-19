import { isSafeHref } from "./sanitize";

// Host side of CONTRACT §5: JSON-RPC 2.0 over postMessage, MCP Apps shaped.

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_FAILED = -32000;

/** Tokens that frames may restyle themselves with. */
export const FRAME_STYLE_VARIABLES = [
  "--bg",
  "--panel",
  "--panel-2",
  "--border",
  "--border-soft",
  "--text",
  "--text-strong",
  "--muted",
  "--accent",
  "--accent-soft",
  "--accent-contrast",
  "--blue",
  "--green",
  "--red",
  "--danger-text",
  "--success-text",
  "--warning-text",
  "--info-text",
  "--input-bg",
] as const;

export interface FrameHostContext {
  theme: string;
  accent: string;
  styles: { variables: Record<string, string> };
  mobile: boolean;
  size: { width: number; height: number };
  safeAreaInsets: { top: number; right: number; bottom: number; left: number };
}

export interface FrameMessageEvent {
  source: unknown;
  data: unknown;
}

export interface FrameBridgeOptions {
  /** The iframe's window, or null once it is gone. */
  frameWindow: () => unknown;
  post: (message: Record<string, unknown>) => void;
  hostContext: () => FrameHostContext;
  call: (method: string, params: unknown) => Promise<unknown>;
  openLink: (url: string) => void;
  onSize: (height: number) => void;
}

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const isId = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

function params(message: RpcMessage): Record<string, unknown> {
  const value = message.params;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class FrameBridge {
  private initialized = false;
  private torn = false;

  constructor(private readonly options: FrameBridgeOptions) {}

  get ready() {
    return this.initialized;
  }

  /** Entry point for `message` events on the host window. */
  handle(event: FrameMessageEvent): void {
    const frame = this.options.frameWindow();
    if (this.torn || !frame || event.source !== frame) return;
    const message = event.data as RpcMessage | null;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0")
      return;
    if (typeof message.method !== "string") return;
    const id = isId(message.id) ? message.id : undefined;
    const method = message.method;

    if (method === "ui/initialize") {
      if (id === undefined) return;
      this.reply(id, {
        hostCapabilities: { openLinks: {}, serverTools: {} },
        hostContext: this.options.hostContext(),
      });
      return;
    }
    if (method === "ui/notifications/initialized") {
      this.initialized = true;
      return;
    }
    // Nothing else is honoured until the handshake finished.
    if (!this.initialized) return;

    switch (method) {
      case "ui/notifications/size-changed": {
        const height = params(message).height;
        if (typeof height === "number" && Number.isFinite(height))
          this.options.onSize(height);
        return;
      }
      case "ui/open-link": {
        const url = params(message).url;
        if (typeof url !== "string" || !isSafeHref(url)) {
          if (id !== undefined)
            this.fail(id, RPC_INVALID_PARAMS, "Only http(s) links open");
          return;
        }
        this.options.openLink(url);
        if (id !== undefined) this.reply(id, {});
        return;
      }
      case "roamgate/call": {
        if (id === undefined) return;
        const { method: target, params: args } = params(message);
        if (typeof target !== "string" || !target) {
          this.fail(id, RPC_INVALID_PARAMS, "method is required");
          return;
        }
        this.options.call(target, args).then(
          (result) => this.reply(id, result ?? null),
          (error: unknown) =>
            this.fail(
              id,
              RPC_FAILED,
              error instanceof Error ? error.message : String(error),
            ),
        );
        return;
      }
      default:
        if (id !== undefined)
          this.fail(id, RPC_METHOD_NOT_FOUND, `Unknown method ${method}`);
    }
  }

  hostContextChanged(): void {
    if (this.initialized)
      this.notify("ui/notifications/host-context-changed", {
        hostContext: this.options.hostContext(),
      });
  }

  /** `$.events.emit` data, or a host payload such as a previewed file. */
  event(name: string, data: unknown): void {
    if (this.initialized) this.notify("roamgate/event", { name, data });
  }

  teardown(): void {
    if (this.torn) return;
    if (this.initialized) this.notify("ui/resource-teardown", {});
    this.torn = true;
    this.initialized = false;
  }

  private notify(method: string, payload: Record<string, unknown>) {
    this.options.post({ jsonrpc: "2.0", method, params: payload });
  }

  private reply(id: string | number, result: unknown) {
    this.options.post({ jsonrpc: "2.0", id, result });
  }

  private fail(id: string | number, code: number, message: string) {
    this.options.post({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
