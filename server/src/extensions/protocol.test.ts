import { expect, test } from "bun:test";
import { EXTENSION_RPC_ERRORS } from "../../../shared/extensions";
import {
  ExtensionProtocolError,
  ExtensionRpcError,
  JsonRpcPeer,
} from "./protocol";

function pair() {
  const sent: { a: string[]; b: string[] } = { a: [], b: [] };
  const a: JsonRpcPeer = new JsonRpcPeer({
    write: (line) => {
      sent.a.push(line);
      b.receive(line);
    },
  });
  const b: JsonRpcPeer = new JsonRpcPeer({
    write: (line) => {
      sent.b.push(line);
      a.receive(line);
    },
    onRequest: (method, params) => {
      if (method === "echo") return params;
      if (method === "later") return Promise.resolve({ ok: true });
      throw new ExtensionRpcError(EXTENSION_RPC_ERRORS.capability, "no");
    },
  });
  return { a, b, sent };
}

test("requests, results and typed errors travel as newline-delimited JSON-RPC", async () => {
  const { a, sent } = pair();
  expect(await a.request("echo", { x: 1 })).toEqual({ x: 1 });
  expect(await a.request("later")).toEqual({ ok: true });
  await expect(a.request("other")).rejects.toMatchObject({
    code: EXTENSION_RPC_ERRORS.capability,
    message: "no",
  });
  for (const line of [...sent.a, ...sent.b]) {
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(JSON.parse(line).jsonrpc).toBe("2.0");
  }
});

test("messages split across chunks and several per chunk are framed by newlines", () => {
  const notes: unknown[] = [];
  const peer = new JsonRpcPeer({
    write: () => undefined,
    onNotification: (method, params) => notes.push([method, params]),
  });
  const encoder = new TextEncoder();
  const text = `${JSON.stringify({ jsonrpc: "2.0", method: "log", params: { m: "h\u00e9" } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "log", params: 2 })}\n`;
  const bytes = encoder.encode(text);
  // The first cut lands between the two UTF-8 bytes of "\u00e9".
  const cut = text.indexOf("\u00e9") + 1;
  peer.receive(bytes.slice(0, cut));
  peer.receive(bytes.slice(cut, cut + 5));
  peer.receive(bytes.slice(cut + 5));
  expect(notes).toEqual([
    ["log", { m: "h\u00e9" }],
    ["log", 2],
  ]);
});

test("oversized or malformed messages close the channel and reject pending requests", async () => {
  const errors: ExtensionProtocolError[] = [];
  const peer = new JsonRpcPeer({
    write: () => undefined,
    onProtocolError: (error) => errors.push(error),
    maxMessageBytes: 32,
  });
  const pending = peer.request("slow");
  peer.receive("x".repeat(40));
  await expect(pending).rejects.toBeInstanceOf(ExtensionProtocolError);
  expect(peer.closed).toBe(true);
  expect(errors[0]?.message).toBe("message exceeds 32 bytes");
  await expect(peer.request("after")).rejects.toThrow();

  const bad = new JsonRpcPeer({
    write: () => undefined,
    onProtocolError: (error) => errors.push(error),
  });
  bad.receive("not json\n");
  expect(bad.closed).toBe(true);
  expect(errors[1]?.message).toBe("invalid JSON-RPC message");
});

test("request timeouts reject with the timeout code", async () => {
  const peer = new JsonRpcPeer({ write: () => undefined });
  await expect(peer.request("never", {}, 1)).rejects.toMatchObject({
    code: EXTENSION_RPC_ERRORS.timeout,
  });
});
