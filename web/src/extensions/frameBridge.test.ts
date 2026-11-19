import { describe, expect, test } from "bun:test";
import {
  FRAME_STYLE_VARIABLES,
  FrameBridge,
  type FrameHostContext,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
} from "./frameBridge";

const win = { id: "frame" };
const other = { id: "intruder" };

function context(theme = "dark"): FrameHostContext {
  return {
    theme,
    accent: "blue",
    styles: { variables: { [FRAME_STYLE_VARIABLES[0]]: "#000" } },
    mobile: false,
    size: { width: 300, height: 200 },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

function setup(
  call: (m: string, p: unknown) => Promise<unknown> = async () => 1,
) {
  const posted: Array<Record<string, unknown>> = [];
  const links: string[] = [];
  const sizes: number[] = [];
  const calls: Array<[string, unknown]> = [];
  let theme = "dark";
  const bridge = new FrameBridge({
    frameWindow: () => win,
    post: (message) => posted.push(message),
    hostContext: () => context(theme),
    call: (method, params) => {
      calls.push([method, params]);
      return call(method, params);
    },
    openLink: (url) => links.push(url),
    onSize: (height) => sizes.push(height),
  });
  const send = (data: unknown, source: unknown = win) =>
    bridge.handle({ source, data });
  const handshake = () => {
    send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    posted.length = 0;
  };
  return {
    bridge,
    posted,
    links,
    sizes,
    calls,
    send,
    handshake,
    setTheme: (next: string) => {
      theme = next;
    },
  };
}

const rpc = (method: string, params?: unknown, id?: number) => ({
  jsonrpc: "2.0",
  method,
  ...(params === undefined ? {} : { params }),
  ...(id === undefined ? {} : { id }),
});

describe("FrameBridge source and handshake checks", () => {
  test("drops messages from any window but the iframe's", () => {
    const { send, posted, bridge } = setup();
    send(rpc("ui/initialize", {}, 1), other);
    send(rpc("ui/notifications/initialized"), other);
    expect(posted).toEqual([]);
    expect(bridge.ready).toBe(false);
    send(rpc("ui/initialize", {}, 1), null);
    expect(posted).toEqual([]);
  });

  test("answers ui/initialize with the host context", () => {
    const { send, posted } = setup();
    send(rpc("ui/initialize", { appCapabilities: {} }, 7));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: {
        hostContext: {
          theme: "dark",
          accent: "blue",
          mobile: false,
          size: { width: 300, height: 200 },
          safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
          styles: { variables: { "--bg": "#000" } },
        },
      },
    });
  });

  test("drops everything else until the frame says it initialized", () => {
    const { send, posted, calls, links, sizes, bridge } = setup();
    send(rpc("ui/initialize", {}, 1));
    posted.length = 0;
    send(rpc("roamgate/call", { method: "x" }, 2));
    send(rpc("ui/open-link", { url: "https://example.com" }, 3));
    send(rpc("ui/notifications/size-changed", { height: 99 }));
    expect(calls).toEqual([]);
    expect(links).toEqual([]);
    expect(sizes).toEqual([]);
    expect(posted).toEqual([]);
    bridge.event("early", 1);
    bridge.hostContextChanged();
    expect(posted).toEqual([]);
    send(rpc("ui/notifications/initialized"));
    expect(bridge.ready).toBe(true);
    send(rpc("ui/notifications/size-changed", { height: 99 }));
    expect(sizes).toEqual([99]);
  });

  test("ignores malformed envelopes", () => {
    const { send, posted, handshake } = setup();
    handshake();
    for (const data of [
      null,
      "text",
      5,
      [],
      { method: "roamgate/call" },
      { jsonrpc: "1.0", method: "roamgate/call", id: 1 },
      { jsonrpc: "2.0", id: 1 },
    ])
      send(data);
    expect(posted).toEqual([]);
  });
});

describe("FrameBridge calls", () => {
  test("roamgate/call is routed to ext.frame.call's handler and answered", async () => {
    const { send, posted, calls, handshake } = setup(
      async (method, params) => ({
        echoed: [method, params],
      }),
    );
    handshake();
    send(rpc("roamgate/call", { method: "series", params: { n: 3 } }, 9));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([["series", { n: 3 }]]);
    expect(posted).toEqual([
      {
        jsonrpc: "2.0",
        id: 9,
        result: { echoed: ["series", { n: 3 }] },
      },
    ]);
  });

  test("a failing call replies with an error, not a result", async () => {
    const { send, posted, handshake } = setup(async () => {
      throw new Error("handler exploded");
    });
    handshake();
    send(rpc("roamgate/call", { method: "boom" }, 4));
    await Promise.resolve();
    await Promise.resolve();
    expect(posted[0]).toMatchObject({
      id: 4,
      error: { message: "handler exploded" },
    });
    expect(posted[0]).not.toHaveProperty("result");
  });

  test("a call without a method name is rejected before reaching the host", () => {
    const { send, posted, calls, handshake } = setup();
    handshake();
    send(rpc("roamgate/call", {}, 5));
    expect(calls).toEqual([]);
    expect(posted[0]).toMatchObject({
      id: 5,
      error: { code: RPC_INVALID_PARAMS },
    });
  });

  test("unknown requests get method-not-found; unknown notifications are silent", () => {
    const { send, posted, handshake } = setup();
    handshake();
    send(rpc("tools/call", {}, 6));
    expect(posted[0]).toMatchObject({
      id: 6,
      error: { code: RPC_METHOD_NOT_FOUND },
    });
    posted.length = 0;
    send(rpc("tools/list"));
    expect(posted).toEqual([]);
  });
});

describe("FrameBridge links, events and context", () => {
  test("only http(s) links open", () => {
    const { send, links, posted, handshake } = setup();
    handshake();
    send(rpc("ui/open-link", { url: "https://example.com/a" }, 1));
    send(rpc("ui/open-link", { url: "http://example.com" }, 2));
    send(rpc("ui/open-link", { url: "javascript:alert(1)" }, 3));
    send(rpc("ui/open-link", { url: "data:text/html,x" }, 4));
    send(rpc("ui/open-link", { url: "/relative" }, 5));
    send(rpc("ui/open-link", {}, 6));
    expect(links).toEqual(["https://example.com/a", "http://example.com"]);
    expect(posted.map((m) => "error" in m)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  test("host-context-changed carries the new theme", () => {
    const { bridge, posted, handshake, setTheme } = setup();
    handshake();
    setTheme("light");
    bridge.hostContextChanged();
    expect(posted).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { hostContext: context("light") },
      },
    ]);
  });

  test("events reach the frame as roamgate/event notifications", () => {
    const { bridge, posted, handshake } = setup();
    handshake();
    bridge.event("tick", { n: 1 });
    expect(posted).toEqual([
      {
        jsonrpc: "2.0",
        method: "roamgate/event",
        params: { name: "tick", data: { n: 1 } },
      },
    ]);
  });

  test("teardown tells the frame once and silences the bridge", () => {
    const { bridge, send, posted, calls, handshake } = setup();
    handshake();
    bridge.teardown();
    bridge.teardown();
    expect(posted).toEqual([
      { jsonrpc: "2.0", method: "ui/resource-teardown", params: {} },
    ]);
    posted.length = 0;
    send(rpc("roamgate/call", { method: "late" }, 1));
    bridge.event("late", 1);
    expect(calls).toEqual([]);
    expect(posted).toEqual([]);
  });

  test("a frame that never initialized gets no teardown message", () => {
    const { bridge, posted } = setup();
    bridge.teardown();
    expect(posted).toEqual([]);
  });
});
