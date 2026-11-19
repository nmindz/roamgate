import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type {
  ExtensionStateResult,
  ExtensionsPush,
} from "../../../shared/extensions";

// happy-dom swaps window/document/MessageEvent; a child run keeps other suites on bun's globals.
if (process.env.ROAMGATE_FRAME_HOST_DOM_TEST !== "1") {
  test("frame host in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_FRAME_HOST_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 30_000);
} else {
  await registerDomTests();
}

async function registerDomTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLIFrameElement",
    "Element",
    "Node",
    "Event",
    "MessageEvent",
    "MutationObserver",
    "localStorage",
    "sessionStorage",
    "getComputedStyle",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { bridge } = await import("../api");
  const { FrameHost, frameSource } = await import("./FrameHost");
  const { setExtensionsState } = await import("./state");

  let container: HTMLElement;
  let root: Root | undefined;

  const state: ExtensionStateResult = {
    safe_mode: false,
    api: "1.0",
    extensions: [
      {
        id: "acme.chart",
        name: "Chart",
        version: "1.0.0",
        status: "active",
        enabled: true,
        capabilities: ["ui"],
        contributions: {
          commands: [],
          slots: [],
          keybindings: [],
          frames: [{ id: "chart", entry: "./frames/chart.html", height: 180 }],
        },
      },
    ],
  };

  async function mount(frame = "chart") {
    setExtensionsState(state);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(h(FrameHost, { ext: "acme.chart", frame })),
    );
    return container.querySelector("iframe") as HTMLIFrameElement | null;
  }

  // The iframe's window is a stub that records what the host posts to it.
  function stubWindow(iframe: HTMLIFrameElement) {
    const posted: Array<Record<string, unknown>> = [];
    const stub = {
      postMessage: (message: Record<string, unknown>, target: string) => {
        expect(target).toBe("*");
        posted.push(message);
      },
    };
    Object.defineProperty(iframe, "contentWindow", {
      value: stub,
      configurable: true,
    });
    return { stub, posted };
  }

  const fromFrame = (source: unknown, data: unknown) =>
    act(async () => {
      const event = new browser.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: source });
      browser.dispatchEvent(event);
    });
  const rpc = (method: string, params?: unknown, id?: number) => ({
    jsonrpc: "2.0",
    method,
    ...(params === undefined ? {} : { params }),
    ...(id === undefined ? {} : { id }),
  });
  async function handshake(source: unknown) {
    await fromFrame(source, rpc("ui/initialize", {}, 1));
    await fromFrame(source, rpc("ui/notifications/initialized"));
  }

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    setExtensionsState(null);
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-theme");
    spyOn(bridge, "call").mockRestore();
    spyOn(bridge, "onExtensions").mockRestore();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
  });

  test("renders a sandboxed opaque-origin iframe on the frame asset route", async () => {
    const iframe = await mount();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("src")).toBe(
      "/ext/acme.chart/frame/frames/chart.html",
    );
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe?.style.height).toBe("180px");
    expect(frameSource("a b", "./x/y z.html")).toBe(
      "/ext/a%20b/frame/x/y%20z.html",
    );
  });

  test("an undeclared frame renders an error, not an iframe", async () => {
    const iframe = await mount("missing");
    expect(iframe).toBeNull();
    expect(container.textContent).toContain("is not declared");
  });

  test("drops messages from other windows and before the handshake", async () => {
    const calls: unknown[] = [];
    spyOn(bridge, "call").mockImplementation(async (...args: unknown[]) => {
      calls.push(args);
      return 1;
    });
    const iframe = await mount();
    const { stub, posted } = stubWindow(iframe!);
    await fromFrame({ other: true }, rpc("ui/initialize", {}, 1));
    expect(posted).toEqual([]);
    await fromFrame(stub, rpc("roamgate/call", { method: "x" }, 2));
    expect(calls).toEqual([]);
    await handshake(stub);
    expect(posted).toHaveLength(1);
    await fromFrame({ other: true }, rpc("roamgate/call", { method: "x" }, 3));
    expect(calls).toEqual([]);
  });

  test("roamgate/call goes through ext.frame.call with the extension and frame", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    spyOn(bridge, "call").mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        calls.push([method, params]);
        return { points: [1, 2] };
      },
    );
    const iframe = await mount();
    const { stub, posted } = stubWindow(iframe!);
    await handshake(stub);
    posted.length = 0;
    await fromFrame(
      stub,
      rpc("roamgate/call", { method: "series", params: { n: 2 } }, 5),
    );
    await act(async () => {});
    expect(calls).toEqual([
      [
        "ext.frame.call",
        {
          ext: "acme.chart",
          frame: "chart",
          method: "series",
          params: { n: 2 },
        },
      ],
    ]);
    expect(posted).toEqual([
      { jsonrpc: "2.0", id: 5, result: { points: [1, 2] } },
    ]);
  });

  test("a theme change reaches the frame within 250 ms", async () => {
    const iframe = await mount();
    const { stub, posted } = stubWindow(iframe!);
    document.documentElement.dataset.theme = "dark";
    await handshake(stub);
    posted.length = 0;
    const started = Date.now();
    document.documentElement.dataset.theme = "light";
    for (let waited = 0; waited < 250 && posted.length === 0; waited += 10)
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      });
    expect(Date.now() - started).toBeLessThan(250);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      method: "ui/notifications/host-context-changed",
      params: { hostContext: { theme: "light" } },
    });
  });

  test("size-changed resizes the iframe within its limits", async () => {
    const iframe = await mount();
    const { stub } = stubWindow(iframe!);
    await handshake(stub);
    await fromFrame(
      stub,
      rpc("ui/notifications/size-changed", { height: 333.2 }),
    );
    expect(iframe?.style.height).toBe("334px");
    await fromFrame(
      stub,
      rpc("ui/notifications/size-changed", { height: 99999 }),
    );
    expect(iframe?.style.height).toBe("4000px");
  });

  test("frame_event pushes for this frame arrive as roamgate/event, others do not", async () => {
    let push: (push: ExtensionsPush) => void = () => {};
    spyOn(bridge, "onExtensions").mockImplementation((cb) => {
      push = cb;
      return () => true;
    });
    const iframe = await mount();
    const { stub, posted } = stubWindow(iframe!);
    await handshake(stub);
    posted.length = 0;
    await act(async () =>
      push({
        frame_event: { ext: "acme.chart", frame: "chart", name: "a", data: 1 },
      }),
    );
    await act(async () =>
      push({ frame_event: { ext: "acme.chart", name: "b", data: 2 } }),
    );
    await act(async () =>
      push({
        frame_event: { ext: "acme.chart", frame: "other", name: "c", data: 3 },
      }),
    );
    await act(async () =>
      push({ frame_event: { ext: "someone.else", name: "d", data: 4 } }),
    );
    expect(posted.map((m) => (m.params as { name: string }).name)).toEqual([
      "a",
      "b",
    ]);
  });

  test("unmounting sends ui/resource-teardown", async () => {
    const iframe = await mount();
    const { stub, posted } = stubWindow(iframe!);
    await handshake(stub);
    posted.length = 0;
    await act(async () => root?.unmount());
    root = undefined;
    expect(posted).toEqual([
      { jsonrpc: "2.0", method: "ui/resource-teardown", params: {} },
    ]);
  });

  test("AC-01-44: a .csv previewer frame gets the file through the bridge, never an authorised URL", async () => {
    const { PreviewFrame } = await import("./PreviewFrame");
    setExtensionsState(state);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        h(PreviewFrame, {
          ext: "acme.chart",
          frame: "chart",
          path: "/repo/data/sales.csv",
          name: "sales.csv",
          content: "a,b\n1,2\n",
          truncated: false,
        }),
      ),
    );
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const src = iframe.getAttribute("src") ?? "";
    // A URL the frame loads would carry the session to the sandbox; the file text must not.
    expect(src).toBe("/ext/acme.chart/frame/frames/chart.html");
    expect(src).not.toMatch(/[?#]|token|sales\.csv|session/i);
    const { stub, posted } = stubWindow(iframe);
    await handshake(stub);
    expect(posted[posted.length - 1]).toEqual({
      jsonrpc: "2.0",
      method: "roamgate/event",
      params: {
        name: "preview.file",
        data: {
          path: "/repo/data/sales.csv",
          name: "sales.csv",
          content: "a,b\n1,2\n",
          truncated: false,
        },
      },
    });
  });
}
