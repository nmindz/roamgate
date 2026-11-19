import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type {
  ExtensionSlotContribution,
  ExtensionStateEntry,
  ExtensionStateResult,
  ExtensionsPush,
} from "../../../shared/extensions";

// React's event setup must see this DOM without changing other tests' globals.
if (process.env.ROAMGATE_EXTENSION_VIEWS_DOM_TEST !== "1") {
  test("extension views in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_EXTENSION_VIEWS_DOM_TEST: "1" },
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
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    "Element",
    "Node",
    "Event",
    "KeyboardEvent",
    "MutationObserver",
    "MouseEvent",
    "localStorage",
    "sessionStorage",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { bridge } = await import("../api");
  const { store } = await import("../store");
  const { Command, CommandList } = await import("../components/ui/command");
  const { ExtensionSlot, syncExtensionsGate } = await import(
    "../extensionsBootstrap"
  );
  const { setExtensionsState } = await import("./state");
  const { ApprovalCard, PaneApprovals, resetApprovals, setApprovals } =
    await import("./approvals");
  const { SlotHost } = await import("./slots");
  const {
    ApprovalsInbox,
    ContextMenuView,
    ExtensionToasts,
    InspectorPanelView,
    PaletteView,
    StatusBarView,
  } = await import("./views");

  let container: HTMLElement;
  let root: Root | undefined;

  function serve(
    handlers: Record<string, (p: Record<string, unknown>) => unknown>,
  ) {
    // No socket hello in tests, so a real lease never reports itself current.
    spyOn(bridge, "connection").mockImplementation(
      () =>
        ({
          connectionId: "alpha",
          generation: 0,
          serverRuntimeGeneration: null,
          call: () => Promise.reject(new Error("unused")),
          isCurrent: () => true,
          acceptsServerGeneration: () => true,
        }) as ReturnType<typeof bridge.connection>,
    );
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    spyOn(bridge, "call").mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected ${method}`);
        return handler(params);
      },
    );
    return calls;
  }

  const entry = (
    id: string,
    slots: ExtensionSlotContribution[] = [],
    patch: Partial<ExtensionStateEntry> = {},
  ): ExtensionStateEntry => ({
    id,
    name: `Ext ${id}`,
    version: "1.0.0",
    status: "active",
    enabled: true,
    capabilities: [],
    contributions: { commands: [], slots, keybindings: [] },
    ...patch,
  });
  const stateOf = (entries: ExtensionStateEntry[]): ExtensionStateResult => ({
    safe_mode: false,
    api: "1.0",
    extensions: entries,
  });

  async function mount(node: Parameters<Root["render"]>[0]) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(node));
    await act(async () => {});
  }
  const buttons = () => [...container.querySelectorAll("button")];
  const button = (label: string) => {
    const found = buttons().find((item) => item.textContent === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found;
  };

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    setExtensionsState(null);
    resetApprovals();
    store.clearNotice();
    document.body.replaceChildren();
    spyOn(bridge, "call").mockRestore();
    spyOn(bridge, "connection").mockRestore();
    spyOn(bridge, "onExtensions").mockRestore();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
  });

  const item = (ext: string, entryId: string, value: unknown) => ({
    key: `${ext}:${entryId}`,
    ext,
    extName: `Ext ${ext}`,
    entryId,
    value,
  });

  test("one entry's render failure shows inline and leaves the others alone", async () => {
    await mount(
      h(SlotHost, {
        slot: "sidebar.section",
        context: {},
        items: [
          item("a", "ok", { t: "Text", text: "fine entry" }),
          item("b", "bad", { t: "Script", src: "evil" }),
          item("c", "err", { error: "handler threw" }),
          item("d", "ok", { t: "Text", text: "last entry" }),
        ],
      }),
    );
    const sections = [...container.querySelectorAll(".ext-entry")];
    expect(sections).toHaveLength(4);
    expect(sections[0].textContent).toBe("fine entry");
    expect(sections[1].querySelector('[role="alert"]')?.textContent).toContain(
      "Unknown element",
    );
    expect(sections[2].querySelector('[role="alert"]')?.textContent).toContain(
      "handler threw",
    );
    expect(sections[3].textContent).toBe("last entry");
  });

  test("buttons show pending state and the handler's error", async () => {
    const calls = serve({
      "ext.command.run": () => {
        throw new Error("denied by host");
      },
    });
    await mount(
      h(SlotHost, {
        slot: "sidebar.section",
        context: { pane_id: "p1" },
        items: [
          item("a", "x", {
            t: "Button",
            id: "go",
            label: "Run it",
            command: "go",
          }),
        ],
      }),
    );
    await act(async () => button("Run it").click());
    await act(async () => {});
    expect(calls[0]).toEqual({
      method: "ext.command.run",
      params: { ext: "a", command: "go", context: { pane_id: "p1" } },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "denied by host",
    );
    expect(button("Run it").disabled).toBe(false);
  });

  test("approval card focuses Deny, and any answer closes it", async () => {
    const calls = serve({ "ext.approval.answer": () => ({ ok: true }) });
    setExtensionsState(stateOf([entry("a")]));
    setApprovals([
      {
        id: "ask1",
        ext: "a",
        event: "pane.close",
        summary: "close pane p1",
        target: { connection_id: "alpha", pane_id: "p1" },
        origin: "ranger",
        reason: "agent is working",
        risk: "high",
      },
    ]);
    await mount(h(PaneApprovals, { paneId: "p1", connectionId: "alpha" }));
    expect(container.textContent).toContain("Ext a asks to close pane p1");
    expect(container.textContent).toContain("agent is working");
    expect(document.activeElement?.textContent).toBe("Deny");
    await act(async () => button("Approve").click());
    await act(async () => {});
    expect(calls[0]).toEqual({
      method: "ext.approval.answer",
      params: { id: "ask1", decision: "approve" },
    });
    expect(container.querySelector(".ext-approval")).toBeNull();
  });

  test("a card closes when another browser answered first", async () => {
    serve({ "ext.approval.answer": () => ({ already_decided: true }) });
    setApprovals([
      {
        id: "ask2",
        ext: "a",
        event: "terminal.submit",
        summary: "send text",
        target: { pane_id: "p9" },
        origin: "browser",
      },
    ]);
    await mount(h(PaneApprovals, { paneId: "p9" }));
    expect(container.querySelector(".ext-approval")).not.toBeNull();
    await act(async () => button("Deny").click());
    await act(async () => {});
    expect(container.querySelector(".ext-approval")).toBeNull();
  });

  test("a push without the ask closes its card, and only matching panes show it", async () => {
    setApprovals([
      {
        id: "ask3",
        ext: "a",
        event: "pane.close",
        summary: "close",
        target: { pane_id: "p1", connection_id: "alpha" },
        origin: "browser",
      },
    ]);
    await mount(
      h("div", null, [
        h(PaneApprovals, { key: "p1", paneId: "p1", connectionId: "alpha" }),
        h(PaneApprovals, { key: "p2", paneId: "p2", connectionId: "alpha" }),
        h(PaneApprovals, { key: "other", paneId: "p1", connectionId: "beta" }),
      ]),
    );
    expect(container.querySelectorAll(".ext-approval")).toHaveLength(1);
    await act(async () => setApprovals([]));
    expect(container.querySelectorAll(".ext-approval")).toHaveLength(0);
  });

  test("the topbar inbox appears with a count only while asks are pending", async () => {
    setExtensionsState(stateOf([entry("a")]));
    await mount(h(ApprovalsInbox));
    expect(container.innerHTML).toBe("");
    await act(async () =>
      setApprovals(
        [1, 2].map((n) => ({
          id: `q${n}`,
          ext: "a",
          event: "pane.close",
          summary: "close",
          target: {},
          origin: "browser",
        })),
      ),
    );
    const trigger = container.querySelector("button");
    expect(trigger?.getAttribute("aria-label")).toBe("Approvals, 2 pending");
    expect(trigger?.textContent).toContain("2");
  });

  test("the card is a labelled group with a described body", async () => {
    await mount(
      h(ApprovalCard, {
        extName: "Guard",
        approval: {
          id: "z",
          ext: "g",
          event: "pane.close",
          summary: "close pane",
          target: {},
          origin: "browser",
          deadline: Date.now() + 90_000,
          on_timeout: "deny",
          detail: "extra detail",
        },
      }),
    );
    const group = container.querySelector('[role="group"]');
    const label = document.getElementById(
      group?.getAttribute("aria-labelledby") ?? "",
    );
    expect(label?.textContent).toBe("Guard asks to close pane");
    expect(
      document.getElementById(group?.getAttribute("aria-describedby") ?? ""),
    ).not.toBeNull();
    expect(container.querySelector("details summary")?.textContent).toBe(
      "Details",
    );
    expect(container.querySelector('[role="timer"]')?.textContent).toMatch(
      /1:(29|30) left; then deny/,
    );
  });

  test("the status bar exists only while an item is visible", async () => {
    serve({ "ext.ui.render": () => ({ entries: [] }) });
    setExtensionsState(stateOf([entry("a")]));
    await mount(h(StatusBarView, { slot: "statusbar.item" }));
    expect(container.innerHTML).toBe("");
    await act(async () =>
      setExtensionsState(
        stateOf([
          entry("a", [
            {
              slot: "statusbar.item",
              id: "s",
              text: "CI green",
              tone: "success",
            },
          ]),
        ]),
      ),
    );
    expect(container.querySelector("footer")?.textContent).toBe("CI green");
    await act(async () =>
      setExtensionsState(
        stateOf([
          entry("a", [{ slot: "statusbar.item", id: "s", text: "x" }], {
            enabled: false,
            status: "disabled",
          }),
        ]),
      ),
    );
    expect(container.querySelector("footer")).toBeNull();
  });

  test("context menus of two extensions never collide on label or key", async () => {
    const calls = serve({
      "ext.ui.render": () => ({ entries: [] }),
      "ext.command.run": () => ({}),
    });
    const same: ExtensionSlotContribution = {
      slot: "context-menu.agent",
      id: "open",
      title: "Open",
      command: "open",
    };
    setExtensionsState(stateOf([entry("a", [same]), entry("b", [same])]));
    await mount(h(ContextMenuView, { slot: "context-menu.agent" }));
    const items = [...container.querySelectorAll(".context-menu-item")];
    expect(items.map((el) => el.textContent)).toEqual(["Open", "Open"]);
    expect(
      [...container.querySelectorAll(".context-menu-group-title")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["Ext a", "Ext b"]);
    await act(async () => (items[1] as HTMLElement).click());
    expect(calls.find((c) => c.method === "ext.command.run")?.params.ext).toBe(
      "b",
    );
  });

  test("a saved Inspector view of a removed extension falls back", async () => {
    serve({ "ext.ui.render": () => ({ entries: [] }) });
    let missing = 0;
    setExtensionsState(
      stateOf([
        entry("a", [{ slot: "inspector.panel", id: "p", title: "Panel" }]),
      ]),
    );
    await mount(
      h(InspectorPanelView, {
        slot: "inspector.panel",
        view: "ext:gone:p",
        onMissing: () => (missing += 1),
      }),
    );
    expect(missing).toBeGreaterThan(0);
    expect(container.innerHTML).toBe("");
  });

  test("an existing Inspector view renders its entry", async () => {
    serve({
      "ext.ui.render": () => ({
        entries: [
          { ext: "a", entry_id: "p", value: { t: "Text", text: "panel body" } },
        ],
      }),
    });
    let missing = 0;
    setExtensionsState(
      stateOf([
        entry("a", [{ slot: "inspector.panel", id: "p", title: "Panel" }]),
      ]),
    );
    await mount(
      h(InspectorPanelView, {
        slot: "inspector.panel",
        view: "ext:a:p",
        onMissing: () => (missing += 1),
      }),
    );
    expect(container.textContent).toContain("panel body");
    expect(missing).toBe(0);
  });

  test("the slot gate renders nothing and reports closed when no extension is enabled", async () => {
    const { extensionsGateOpen } = await import("../extensionsBootstrap");
    await mount(h(ExtensionSlot, { slot: "inspector.panel", view: "ext:a:p" }));
    await act(async () => syncExtensionsGate({ extensions: [] }));
    // The Inspector host reads this same gate to fall back to Files.
    expect(extensionsGateOpen()).toBe(false);
    expect(container.innerHTML).toBe("");
  });

  test("toasts stack at most five apart from the core notice", async () => {
    let push: (push: ExtensionsPush) => void = () => {};
    spyOn(bridge, "onExtensions").mockImplementation((cb) => {
      push = cb;
      return () => true;
    });
    store.notify({ kind: "info", message: "core notice" });
    await mount(h(ExtensionToasts));
    for (let n = 1; n <= 7; n++)
      await act(async () =>
        push({ toast: { ext: "a", kind: "info", message: `toast ${n}` } }),
      );
    const shown = [...container.querySelectorAll(".toast strong")].map(
      (el) => el.textContent,
    );
    expect(shown).toEqual([
      "toast 3",
      "toast 4",
      "toast 5",
      "toast 6",
      "toast 7",
    ]);
    expect(store.get().notice?.message).toBe("core notice");
  });

  test("palette entries group by extension, filter by search and run", async () => {
    const calls = serve({
      "ext.ui.render": () => ({ entries: [] }),
      "ext.command.run": () => ({}),
    });
    setExtensionsState(
      stateOf([
        entry("a", [], {
          contributions: {
            commands: [
              { id: "say-hi", title: "Say hi", keywords: ["greet"] },
              { id: "other", title: "Other thing" },
            ],
            slots: [],
            keybindings: [],
          },
        }),
      ]),
    );
    let ran = 0;
    const palette = (search: string) =>
      h(
        Command,
        { shouldFilter: false },
        h(
          CommandList,
          null,
          h(PaletteView, { slot: "command", search, onRun: () => (ran += 1) }),
        ),
      );
    await mount(palette(""));
    expect(container.textContent).toContain("Ext a");
    expect(container.textContent).toContain("Say hi");
    expect(container.textContent).toContain("Other thing");
    await act(async () => root?.render(palette("greet")));
    expect(container.textContent).toContain("Say hi");
    expect(container.textContent).not.toContain("Other thing");
    await act(async () =>
      (container.querySelector("[cmdk-item]") as HTMLElement).click(),
    );
    await act(async () => {});
    expect(
      calls.find((c) => c.method === "ext.command.run")?.params,
    ).toMatchObject({ ext: "a", command: "say-hi" });
    expect(ran).toBe(1);
  });

  test("AC-01-22: on mobile every P1 slot of hello, guard-rails and ci-badges lands at its placement", async () => {
    const { updateLayoutPreferences } = await import("../layoutPreferences");
    const { BadgesView } = await import("./views");
    updateLayoutPreferences({ mode: "mobile" });
    expect(document.documentElement.dataset.layout).toBe("mobile");
    const calls = serve({
      "ext.ui.render": (params) =>
        params.slot === "workspace.badge"
          ? {
              entries: [
                {
                  ext: "ci",
                  entry_id: "status",
                  value: { text: "green", tone: "success" },
                },
              ],
            }
          : params.slot === "inspector.panel"
            ? {
                entries: [
                  {
                    ext: "ci",
                    entry_id: "runs",
                    value: { t: "Text", text: "run list" },
                  },
                ],
              }
            : params.slot === "statusbar.item"
              ? {
                  entries: [
                    {
                      ext: "hello",
                      entry_id: "item",
                      value: { text: "Hello ready" },
                    },
                  ],
                }
              : { entries: [] },
      "ext.command.run": () => ({}),
    });
    setExtensionsState(
      stateOf([
        entry("hello", [{ slot: "statusbar.item", id: "item" }], {
          contributions: {
            commands: [{ id: "say-hi", title: "Say hi" }],
            slots: [{ slot: "statusbar.item", id: "item" }],
            keybindings: [],
          },
        }),
        entry("guard", []),
        entry(
          "ci",
          [
            { slot: "workspace.badge", id: "status" },
            { slot: "inspector.panel", id: "runs", title: "Runs" },
          ],
          {},
        ),
      ]),
    );
    setApprovals([
      {
        id: "ask-m",
        ext: "guard",
        event: "pane.close",
        summary: "close working agent",
        target: { pane_id: "p1", connection_id: "alpha" },
        origin: "browser",
      },
    ]);
    await mount(
      h("div", null, [
        h(
          Command,
          { key: "palette", shouldFilter: false },
          h(CommandList, null, h(PaletteView, { slot: "command", search: "" })),
        ),
        h(BadgesView, { key: "badge", slot: "workspace.badge" }),
        h(InspectorPanelView, {
          key: "panel",
          slot: "inspector.panel",
          view: "ext:ci:runs",
        }),
        h(StatusBarView, { key: "status", slot: "statusbar.item" }),
        h(PaneApprovals, { key: "ask", paneId: "p1", connectionId: "alpha" }),
      ]),
    );
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("Say hi");
    expect(text).toContain("green");
    expect(text).toContain("run list");
    expect(text).toContain("close working agent");
    expect(container.querySelector("footer")).toBeNull();
    expect(text).not.toContain("Hello ready");
    expect(calls.some((c) => c.method === "ext.ui.render")).toBe(true);
    updateLayoutPreferences({ mode: "auto" });
  });
}
