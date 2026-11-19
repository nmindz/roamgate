import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type {
  ExtensionKeybindingState,
  ExtensionStateEntry,
  ExtensionStateResult,
} from "../../../shared/extensions";

// happy-dom swaps window/document/KeyboardEvent; a child run keeps other suites on bun's globals.
if (process.env.ROAMGATE_DYNAMIC_SHORTCUTS_DOM_TEST !== "1") {
  test("dynamic shortcuts in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_DYNAMIC_SHORTCUTS_DOM_TEST: "1" },
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
    "Element",
    "Node",
    "Event",
    "KeyboardEvent",
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
  const { getShortcutSnapshot } = await import("../shortcutPreferences");
  const dynamic = await import("./dynamicShortcuts");
  const { setExtensionsState } = await import("./state");
  const { roamgateLocalStorage } = await import("../browserStorage");
  const { resetPluginActions } = await import("./plugins");
  const { PaletteView } = await import("./views");
  const { ShortcutSettings } = await import("./ShortcutSettings");

  const platform = getShortcutSnapshot().platform;
  let container: HTMLElement;
  let root: Root | undefined;

  const allPlatforms = (key: string) => ({
    mac: key,
    windows: key,
    linux: key,
  });
  const binding = (
    command: string,
    key: string,
    conflicts: ExtensionKeybindingState["conflicts"] = [],
  ): ExtensionKeybindingState => ({
    command,
    key,
    keys: allPlatforms(key),
    conflicts,
  });
  const entry = (
    id: string,
    keybindings: ExtensionKeybindingState[],
    patch: Partial<ExtensionStateEntry> = {},
  ): ExtensionStateEntry => ({
    id,
    name: `Ext ${id}`,
    version: "1.0.0",
    status: "active",
    enabled: true,
    capabilities: ["commands"],
    contributions: {
      commands: keybindings.map((item) => ({
        id: item.command,
        title: `Run ${item.command}`,
      })),
      slots: [],
      keybindings,
    },
    ...patch,
  });
  const stateOf = (entries: ExtensionStateEntry[]): ExtensionStateResult => ({
    safe_mode: false,
    api: "1.0",
    extensions: entries,
  });

  const press = (
    init: Record<string, unknown>,
    target: EventTarget = document.body,
  ) => {
    const event = new browser.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    } as ConstructorParameters<typeof browser.KeyboardEvent>[1]);
    target.dispatchEvent(event as unknown as Event);
    return event as unknown as KeyboardEvent;
  };
  const ctrlAlt = (letter: string, extra: Record<string, unknown> = {}) =>
    press({
      key: letter.toLowerCase(),
      code: `Key${letter.toUpperCase()}`,
      ctrlKey: true,
      altKey: true,
      ...extra,
    });

  function serve(
    handlers: Record<string, (p: Record<string, unknown>) => unknown> = {},
  ) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    spyOn(bridge, "connection").mockImplementation(
      () =>
        ({
          connectionId: "alpha",
          generation: 0,
          serverRuntimeGeneration: null,
          call: async (
            method: string,
            params: Record<string, unknown> = {},
          ) => {
            calls.push({ method, params });
            const handler = handlers[method];
            if (!handler) throw new Error(`unexpected ${method}`);
            return handler(params);
          },
          isCurrent: () => true,
          acceptsServerGeneration: () => true,
        }) as ReturnType<typeof bridge.connection>,
    );
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

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    dynamic.uninstallKeybindings();
    localStorage.clear();
    setExtensionsState(null);
    resetPluginActions();
    document.body.replaceChildren();
    spyOn(bridge, "call").mockRestore();
    spyOn(bridge, "connection").mockRestore();
    spyOn(store, "invokeHerdrPluginAction").mockRestore();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
  });

  test("parses ext and herdr shortcut ids", () => {
    expect(dynamic.parseShortcutId("ext:acme.ci:rerun")).toEqual({
      kind: "ext",
      ext: "acme.ci",
      command: "rerun",
    });
    expect(dynamic.parseShortcutId("herdr:herdr-float.toggle")).toEqual({
      kind: "herdr",
      plugin: "herdr-float",
      action: "toggle",
    });
    expect(dynamic.parseShortcutId("tab.close")).toBeNull();
    expect(dynamic.parseShortcutId("ext:only")).toBeNull();
    expect(dynamic.extensionShortcutId("a", "b")).toBe("ext:a:b");
    expect(dynamic.herdrShortcutId("p", "q")).toBe("herdr:p.q");
  });

  test("an extension default runs its command with the active context", async () => {
    const calls = serve({ "ext.command.run": () => ({}) });
    setExtensionsState(
      stateOf([entry("acme.ci", [binding("rerun", "Ctrl+Alt+X")])]),
    );
    dynamic.installKeybindings();
    const event = ctrlAlt("x");
    await act(async () => {});
    expect(event.defaultPrevented).toBe(true);
    const run = calls.find((call) => call.method === "ext.command.run");
    expect(run?.params).toMatchObject({ ext: "acme.ci", command: "rerun" });
    expect(run?.params.context).toMatchObject({ connection_id: "alpha" });
  });

  test("a binding that lost on this platform stays unbound and is reported", () => {
    const state = stateOf([
      entry("a", [
        binding("x", "Ctrl+Alt+X", [
          { platform, key: "Ctrl+Alt+X", winner: "ext:b:y", kind: "extension" },
        ]),
      ]),
    ]);
    const { byKey, dropped } = dynamic.effectiveBindings(state, platform, {});
    expect(byKey.size).toBe(0);
    expect(dropped).toEqual([
      { id: "ext:a:x", key: "Ctrl+Alt+X", reason: "ext:b:y keeps it" },
    ]);
  });

  test("a user binding beats an extension default for the same key and for its own command", () => {
    const state = stateOf([
      entry("a", [binding("x", "Ctrl+Alt+X")]),
      entry("b", [binding("y", "Ctrl+Alt+V")]),
    ]);
    const user = { "herdr:p.go": ["Ctrl+Alt+X"], "ext:b:y": ["Ctrl+Alt+P"] };
    const { byKey, dropped } = dynamic.effectiveBindings(state, platform, user);
    expect(byKey.get("Ctrl+Alt+X")).toEqual({
      id: "herdr:p.go",
      source: "user",
    });
    expect(byKey.get("Ctrl+Alt+P")).toEqual({ id: "ext:b:y", source: "user" });
    expect(byKey.has("Ctrl+Alt+V")).toBe(false);
    expect(dropped.map((item) => item.id)).toEqual(["ext:a:x"]);
  });

  test("a bound Herdr plugin action invokes through the generic path", async () => {
    serve();
    const invoke = spyOn(store, "invokeHerdrPluginAction").mockResolvedValue(
      undefined as never,
    );
    dynamic.setUserBinding("herdr:herdr-float.toggle", ["Ctrl+Alt+Y"]);
    ctrlAlt("y");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0].slice(0, 2)).toEqual(["herdr-float", "toggle"]);
    expect(invoke.mock.calls[0][2]).toMatchObject({
      invocation_source: "roamgate",
    });
  });

  test("bindings persist and a reset restores the extension default", () => {
    setExtensionsState(stateOf([entry("a", [binding("x", "Ctrl+Alt+X")])]));
    dynamic.setUserBinding("ext:a:x", ["Ctrl+Alt+R"]);
    expect(dynamic.readUserBindings()).toEqual({ "ext:a:x": ["Ctrl+Alt+R"] });
    expect(
      roamgateLocalStorage.getItem(dynamic.DYNAMIC_SHORTCUTS_KEY),
    ).not.toBeNull();
    dynamic.resetUserBinding("ext:a:x");
    expect(dynamic.readUserBindings()).toEqual({});
    expect(
      roamgateLocalStorage.getItem(dynamic.DYNAMIC_SHORTCUTS_KEY),
    ).toBeNull();
  });

  test("keys a core shortcut holds, plain keys and other users' keys are refused", () => {
    const { preset } = getShortcutSnapshot();
    const coreKey = preset.bindings["tab.close"][0];
    expect(dynamic.bindingError("herdr:p.a", coreKey)).toContain("built-in");
    expect(() => dynamic.setUserBinding("herdr:p.a", [coreKey])).toThrow(
      /built-in/,
    );
    expect(() => dynamic.setUserBinding("herdr:p.a", ["K"])).toThrow();
    dynamic.setUserBinding("herdr:p.a", ["Ctrl+Alt+N"]);
    expect(dynamic.bindingError("herdr:p.b", "Ctrl+Alt+N")).toContain(
      "Already bound",
    );
    expect(dynamic.bindingError("herdr:p.a", "Ctrl+Alt+N")).toBeNull();
  });

  test("typing in a field, a modal and key repeats never run shortcuts", async () => {
    const calls = serve({ "ext.command.run": () => ({}) });
    setExtensionsState(stateOf([entry("a", [binding("x", "Ctrl+Alt+X")])]));
    dynamic.installKeybindings();
    const input = document.createElement("input");
    document.body.append(input);
    ctrlAlt("x", {});
    calls.length = 0;
    const typed = press(
      { key: "x", code: "KeyX", ctrlKey: true, altKey: true },
      input,
    );
    expect(typed.defaultPrevented).toBe(false);
    const modal = document.createElement("div");
    modal.className = "modal-backdrop";
    document.body.append(modal);
    ctrlAlt("x");
    modal.remove();
    ctrlAlt("x", { repeat: true });
    await act(async () => {});
    expect(calls.filter((call) => call.method === "ext.command.run")).toEqual(
      [],
    );
  });

  test("safe mode and disabled extensions leave their keys unbound", () => {
    const state = stateOf([
      entry("a", [binding("x", "Ctrl+Alt+X")], {
        enabled: false,
        status: "disabled",
      }),
    ]);
    expect(dynamic.effectiveBindings(state, platform, {}).byKey.size).toBe(0);
    const safe = {
      ...stateOf([entry("a", [binding("x", "Ctrl+Alt+X")])]),
      safe_mode: true,
    };
    expect(dynamic.effectiveBindings(safe, platform, {}).byKey.size).toBe(0);
  });

  test("the palette lists Herdr plugin actions and runs one with the pane context", async () => {
    const calls = serve({
      "plugin.action.list": () => ({
        type: "plugin_action_list",
        actions: [
          {
            plugin_id: "herdr-float",
            action_id: "toggle",
            title: "Toggle float",
            description: "Shell popup",
            contexts: ["global"],
            command: ["x"],
          },
          { plugin_id: "bad" },
        ],
      }),
    });
    const invoke = spyOn(store, "invokeHerdrPluginAction").mockResolvedValue(
      undefined as never,
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const pane = {
      pane_id: "p1",
      terminal_id: "t1",
      workspace_id: "w1",
      tab_id: "tab1",
      focused: true,
      cwd: "/repo",
      agent: "claude",
      agent_status: "idle",
      revision: 1,
    };
    const palette = (search: string) =>
      h(
        Command,
        { shouldFilter: false },
        h(
          CommandList,
          null,
          h(PaletteView, { slot: "command", search, pane, onRun: () => {} }),
        ),
      );
    await act(async () => root?.render(palette("")));
    await act(async () => {});
    expect(calls.map((call) => call.method)).toContain("plugin.action.list");
    expect(container.textContent).toContain("Herdr plugins");
    expect(container.textContent).toContain("herdr-float: Toggle float");
    expect(container.textContent).not.toContain("bad");
    await act(async () => root?.render(palette("nothing-matches")));
    expect(container.textContent).not.toContain("Toggle float");
    await act(async () => root?.render(palette("float")));
    await act(async () =>
      (container.querySelector("[cmdk-item]") as HTMLElement).click(),
    );
    expect(invoke).toHaveBeenCalledWith(
      "herdr-float",
      "toggle",
      expect.objectContaining({
        focused_pane_id: "p1",
        focused_pane_cwd: "/repo",
        focused_pane_agent: "claude",
        workspace_id: "w1",
        tab_id: "tab1",
      }),
    );
  });

  test("plugin actions are fetched once per connection generation", async () => {
    const calls = serve({
      "plugin.action.list": () => ({ actions: [] }),
    });
    const { loadPluginActions } = await import("./plugins");
    const client = bridge.connection("alpha", null);
    await loadPluginActions(client);
    await loadPluginActions(client);
    expect(
      calls.filter((call) => call.method === "plugin.action.list"),
    ).toHaveLength(1);
    resetPluginActions();
    await loadPluginActions(client);
    expect(
      calls.filter((call) => call.method === "plugin.action.list"),
    ).toHaveLength(2);
  });

  test("the settings section lists commands and actions, records a key and shows overrides", async () => {
    serve({
      "plugin.action.list": () => ({
        actions: [
          {
            plugin_id: "herdr-float",
            action_id: "toggle",
            title: "Toggle float",
            contexts: [],
            command: [],
          },
        ],
      }),
    });
    setExtensionsState(
      stateOf([entry("acme.ci", [binding("rerun", "Ctrl+Alt+X")])]),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(h(ShortcutSettings)));
    await act(async () => {});
    expect(container.textContent).toContain("Run rerun");
    expect(container.textContent).toContain("Toggle float");
    const change = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change shortcut for Toggle float"]',
    )!;
    await act(async () => change.click());
    await act(async () => {
      press({ key: "u", code: "KeyU", ctrlKey: true, altKey: true });
    });
    expect(dynamic.readUserBindings()).toEqual({
      "herdr:herdr-float.toggle": ["Ctrl+Alt+U"],
    });
    expect(
      container.querySelector(
        'button[aria-label="Reset shortcut for Toggle float"]',
      ),
    ).not.toBeNull();
    // A key a core shortcut holds is refused with the reason shown.
    const { preset } = getShortcutSnapshot();
    const coreKey = preset.bindings["tab.close"][0];
    const run = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change shortcut for Run rerun"]',
    )!;
    await act(async () => run.click());
    const [ctrl, alt, meta] = [
      coreKey.includes("Ctrl"),
      coreKey.includes("Alt"),
      coreKey.includes("Meta"),
    ];
    const letter = coreKey.split("+").pop() ?? "w";
    await act(async () => {
      press({
        key: letter.toLowerCase(),
        code: `Key${letter.toUpperCase()}`,
        ctrlKey: ctrl,
        altKey: alt,
        metaKey: meta,
        shiftKey: coreKey.includes("Shift"),
      });
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "built-in",
    );
    expect(dynamic.readUserBindings()["ext:acme.ci:rerun"]).toBeUndefined();
  });
}
