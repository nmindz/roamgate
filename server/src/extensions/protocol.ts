import { EXTENSION_RPC_ERRORS } from "../../../shared/extensions";

/** Newline-delimited JSON-RPC 2.0 between the bridge and an extension child. */

/** One message may carry a 4 MiB process output or fetch body after escaping. */
export const MAX_EXTENSION_MESSAGE_BYTES = 16 * 1024 * 1024;

export class ExtensionRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionRpcError";
  }
}

export class ExtensionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionProtocolError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export interface JsonRpcPeerOptions {
  /** Writes one complete line, newline included. */
  write: (line: string) => void;
  onRequest?: (method: string, params: unknown) => unknown;
  onNotification?: (method: string, params: unknown) => void;
  /** The stream broke framing; the peer is closed and must be discarded. */
  onProtocolError?: (error: ExtensionProtocolError) => void;
  maxMessageBytes?: number;
}

function errorPayload(error: unknown): { code: number; message: string } {
  if (error instanceof ExtensionRpcError)
    return { code: error.code, message: error.message };
  return {
    code: EXTENSION_RPC_ERRORS.internal,
    message: error instanceof Error ? error.message : String(error),
  };
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private bufferBytes = 0;
  private closedError: Error | null = null;
  private readonly maxBytes: number;

  constructor(private readonly options: JsonRpcPeerOptions) {
    this.maxBytes = options.maxMessageBytes ?? MAX_EXTENSION_MESSAGE_BYTES;
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            reject(
              new ExtensionRpcError(
                EXTENSION_RPC_ERRORS.timeout,
                `${method} timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    try {
      this.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.settle(id)?.reject(error as Error);
    }
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Feeds bytes read from the other side. */
  receive(chunk: Uint8Array | string): void {
    if (this.closedError) return;
    const text =
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end < 0) break;
      const line = this.buffer + text.slice(start, end);
      this.buffer = "";
      this.bufferBytes = 0;
      start = end + 1;
      if (line.length > this.maxBytes) {
        this.fail(`message exceeds ${this.maxBytes} bytes`);
        return;
      }
      if (line.trim()) this.handleLine(line);
      if (this.closedError) return;
    }
    const rest = text.slice(start);
    this.buffer += rest;
    this.bufferBytes += rest.length;
    if (this.bufferBytes > this.maxBytes)
      this.fail(`message exceeds ${this.maxBytes} bytes`);
  }

  /** Rejects outstanding requests; later calls fail with `error`. */
  close(error: Error = new Error("extension channel closed")): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error);
  }

  private send(message: Record<string, unknown>): void {
    this.options.write(`${JSON.stringify(message)}\n`);
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private fail(message: string): void {
    const error = new ExtensionProtocolError(message);
    this.close(error);
    this.options.onProtocolError?.(error);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      this.fail("invalid JSON-RPC message");
      return;
    }
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined) {
        this.options.onNotification?.(method, message.params);
        return;
      }
      if (typeof id !== "number" && typeof id !== "string") {
        this.fail("invalid JSON-RPC id");
        return;
      }
      this.answer(id, method, message.params);
      return;
    }
    if (typeof id !== "number") {
      this.fail("response without a request id");
      return;
    }
    const pending = this.settle(id);
    if (!pending) return;
    const error = message.error as { code?: unknown; message?: unknown } | null;
    if (error && typeof error === "object") {
      pending.reject(
        new ExtensionRpcError(
          typeof error.code === "number"
            ? error.code
            : EXTENSION_RPC_ERRORS.internal,
          typeof error.message === "string" ? error.message : "error",
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private answer(id: number | string, method: string, params: unknown): void {
    const reply = (body: Record<string, unknown>) => {
      if (!this.closedError) this.send({ jsonrpc: "2.0", id, ...body });
    };
    if (!this.options.onRequest) {
      reply({
        error: {
          code: EXTENSION_RPC_ERRORS.methodNotFound,
          message: `unknown method: ${method}`,
        },
      });
      return;
    }
    let result: unknown;
    try {
      result = this.options.onRequest(method, params);
    } catch (error) {
      reply({ error: errorPayload(error) });
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        try {
          reply({ result: value ?? null });
        } catch (error) {
          reply({ error: errorPayload(error) });
        }
      },
      (error) => reply({ error: errorPayload(error) }),
    );
  }
}
