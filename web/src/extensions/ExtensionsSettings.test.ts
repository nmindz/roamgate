import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type {
  ExtensionStateEntry,
  ExtensionStateResult,
} from "../../../shared/extensions";

// React's event setup must see this DOM without changing other tests' globals.
if (process.env.ROAMGATE_EXTENSIONS_DOM_TEST !== "1") {
  test("extension settings in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_EXTENSIONS_DOM_TEST: "1" },
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
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { bridge } = await import("../api");
  const { ExtensionSlot, syncExtensionsGate } = await import(
    "../extensionsBootstrap"
  );
  const { setExtensionsState } = await import("./state");
  const { ExtensionsSettings } = await import("./ExtensionsSettings");
  const { ExtensionNotices, extensionNotices } = await import(
    "./ExtensionNotices"
  );

  let container: HTMLElement;
  let root: Root | undefined;

  type Handler = (params: Record<string, unknown>) => unknown;
  function serve(handlers: Record<string, Handler>) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const spy = spyOn(bridge, "call").mockImplementation(
      async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected ${method}`);
        return handler(params);
      },
    );
    return { calls, spy };
  }

  const entry = (
    patch: Partial<ExtensionStateEntry> = {},
  ): ExtensionStateEntry => ({
    id: "acme.ci",
    name: "CI badges",
    version: "1.2.0",
    status: "active",
    enabled: true,
    capabilities: ["ui", "network"],
    contributions: {
      commands: [{ id: "rerun", title: "Re-run CI" }],
      slots: [{ slot: "workspace.badge", id: "status" }],
      keybindings: [
        {
          command: "rerun",
          key: "mod+shift+r",
          keys: {
            mac: "Meta+Shift+R",
            windows: "Ctrl+Shift+R",
            linux: "Ctrl+Shift+R",
          },
          conflicts: [],
        },
      ],
    },
    ...patch,
  });
  const stateOf = (
    extensions: ExtensionStateEntry[],
    safe_mode = false,
  ): ExtensionStateResult => ({ safe_mode, api: "1.0", extensions });

  async function mount(node: Parameters<Root["render"]>[0]) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(node));
  }
  const flush = () => act(async () => {});
  const buttons = () => [...container.querySelectorAll("button")];
  const button = (label: string) => {
    const found = buttons().find((item) => item.textContent === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found;
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  const type = async (element: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )?.set?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    setExtensionsState(null);
    document.body.replaceChildren();
    browser.sessionStorage.clear();
    spyOn(bridge, "call").mockRestore();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => {
    await browser.happyDOM.close();
  });

  test("lists extensions with status and capability chips", async () => {
    setExtensionsState(
      stateOf([
        entry(),
        entry({
          id: "b",
          name: "Guard",
          status: "disabled",
          enabled: false,
          capabilities: [],
        }),
      ]),
    );
    await mount(h(ExtensionsSettings));
    const text = container.textContent ?? "";
    expect(text).toContain("2 installed");
    expect(text).toContain("CI badges");
    expect(text).toContain("Active");
    expect(text).toContain("Disabled");
    const chips = [...container.querySelectorAll(".ext-chip")].map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["ui", "network"]);
    expect(container.querySelector(".ext-banner")).toBeNull();
  });

  test("reports an unavailable server and an empty list", async () => {
    await mount(h(ExtensionsSettings));
    expect(container.textContent).toContain("not available on this server");
    await act(async () => setExtensionsState(stateOf([])));
    expect(container.textContent).toContain("No extensions installed.");
  });

  test("shows the safe-mode banner and turns safe mode off", async () => {
    setExtensionsState(stateOf([entry({ status: "safe_mode" })], true));
    const { calls } = serve({ "ext.manage": () => ({}) });
    await mount(h(ExtensionsSettings));
    const banner = container.querySelector(".ext-banner");
    expect(banner?.textContent).toContain("Safe mode is on");
    expect(container.textContent).toContain("Not loaded (safe mode)");
    await click("Turn off safe mode");
    expect(calls).toEqual([
      { method: "ext.manage", params: { op: "safe_mode", enabled: false } },
    ]);
  });

  test("shows an auto-disabled notice that opens the extension", async () => {
    setExtensionsState(
      stateOf([
        entry({
          status: "failed",
          enabled: false,
          last_error: { at: 5, message: "timed out in ui.render" },
        }),
      ]),
    );
    serve({
      "ext.config.get": () => ({ schema: {}, values: {} }),
      "ext.logs": () => ({ lines: [] }),
    });
    await mount(h(ExtensionsSettings));
    const banner = container.querySelector(".ext-banner-danger");
    expect(banner?.textContent).toContain(
      "CI badges was disabled after repeated failures",
    );
    expect(banner?.textContent).toContain("timed out in ui.render");
    await click("Review");
    await flush();
    expect(container.textContent).toContain("Back to extensions");
    expect(container.textContent).toContain("Last error: timed out");
  });

  const openRow = async (name: string) => {
    const row = [...container.querySelectorAll<HTMLElement>(".ext-row")].find(
      (item) => item.textContent?.includes(name),
    );
    if (!row) throw new Error(`no row ${name}`);
    await act(async () => row.click());
    await flush();
  };
  const field = (label: string) => {
    const labelElement = [...container.querySelectorAll("label")].find((item) =>
      item.textContent?.startsWith(label),
    );
    return container.querySelector<HTMLInputElement>(
      `#${labelElement?.getAttribute("for")}`,
    ) as HTMLInputElement;
  };
  const noDiff = Object.fromEntries(
    ["capabilities", "events", "hooks", "routes", "imports"].map((k) => [
      k,
      { added: [], removed: [] },
    ]),
  );
  const summary = (patch: Record<string, unknown> = {}) => ({
    id: "acme.ci",
    name: "CI badges",
    version: "1.2.0",
    source: { kind: "github", location: "acme/ci" },
    capabilities: [],
    events: [],
    gates: [],
    hooks: [],
    routes: [],
    network_hosts: [],
    build: [],
    imports: [],
    calls: [],
    mismatches: [],
    unreadable: [],
    warnings: [],
    notice: "Extensions run with your user permissions and are not sandboxed.",
    ...patch,
  });
  test("extension page edits settings, shows logs and manages the extension", async () => {
    setExtensionsState(stateOf([entry(), entry({ id: "b", name: "Guard" })]));
    const { calls } = serve({
      "ext.config.get": () => ({
        schema: {
          org: { type: "string", title: "Organisation" },
          token: { type: "secret", title: "GitHub token" },
          limit: { type: "number", title: "Limit", default: 5 },
        },
        values: { org: "acme", token: { set: true } },
      }),
      "ext.logs": () => ({
        lines: [{ at: 1_700_000_000_000, level: "info", line: "ready" }],
      }),
      "ext.config.set": () => ({}),
      "ext.manage": (params) =>
        params.op === "consent"
          ? {
              summary: summary({
                events: ["agent.status"],
                hooks: [{ on: "pane.close", command: ["sh", "guard.sh"] }],
              }),
              diff: noDiff,
              needs_consent: false,
            }
          : {},
    });
    await mount(h(ExtensionsSettings));
    await openRow("CI badges");
    const text = container.textContent ?? "";
    expect(text).toContain("acme.ci 1.2.0 from github: acme/ci");
    expect(text).toContain("rerun: Re-run CI");
    expect(text).toContain("workspace.badge/status");
    expect(text).toContain("mod+shift+r runs rerun");
    expect(text).toContain("agent.status");
    expect(text).toContain("pane.close: sh guard.sh");
    expect(container.querySelector(".ext-logs")?.textContent).toContain(
      "info ready",
    );
    expect(field("Organisation").value).toBe("acme");
    expect(field("GitHub token").value).toBe("");
    expect(field("GitHub token").placeholder).toBe("Set (hidden)");
    expect(field("Limit").value).toBe("5");
    expect(button("Save settings").disabled).toBe(true);

    await type(field("Organisation"), "globex");
    await click("Save settings");
    // An untouched secret is never sent; only what changed is.
    expect(calls.filter((c) => c.method === "ext.config.set")).toEqual([
      {
        method: "ext.config.set",
        params: { ext: "acme.ci", key: "org", value: "globex" },
      },
    ]);
    expect(container.textContent).toContain("Saved");

    await click("Disable");
    await click("Move down");
    await click("Refresh logs");
    expect(
      calls
        .filter((c) => c.method === "ext.manage" && c.params.op !== "consent")
        .map((c) => c.params),
    ).toEqual([
      { op: "disable", id: "acme.ci" },
      { op: "order", ids: ["b", "acme.ci"] },
    ]);
    expect(calls.filter((c) => c.method === "ext.logs").length).toBe(2);

    await click("Uninstall");
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[role="alertdialog"] input')
        ?.click(),
    );
    const confirm = container.querySelectorAll<HTMLButtonElement>(
      '[role="alertdialog"] button',
    )[1];
    await act(async () => confirm.click());
    await flush();
    expect(calls[calls.length - 1]).toEqual({
      method: "ext.manage",
      params: { op: "uninstall", id: "acme.ci", keep_data: true },
    });
    expect(container.textContent).toContain("2 installed");
  });

  test("connection-scoped settings read and save against the active connection", async () => {
    setExtensionsState(stateOf([entry()]));
    const { calls } = serve({
      "ext.config.get": () => ({
        schema: {
          shared: { type: "string", title: "Shared" },
          perconn: {
            type: "string",
            title: "Per connection",
            scope: "connection",
          },
        },
        values: {},
      }),
      "ext.logs": () => ({ lines: [] }),
      "ext.manage": () => ({ needs_consent: false }),
      "ext.config.set": () => ({ ok: true }),
    });
    await mount(h(ExtensionsSettings));
    await openRow("CI badges");
    const get = calls.find((c) => c.method === "ext.config.get");
    expect(typeof get?.params.connection_id).toBe("string");
    expect(container.textContent).toContain("Saved for");
    await type(field("Shared"), "a");
    await type(field("Per connection"), "b");
    await click("Save settings");
    const sets = calls.filter((c) => c.method === "ext.config.set");
    expect(sets.map((c) => c.params.key)).toEqual(["shared", "perconn"]);
    expect(sets[0].params).not.toHaveProperty("connection_id");
    expect(sets[1].params.connection_id).toBe(get?.params.connection_id);
  });

  test("enabling an extension never consented to shows the consent view first", async () => {
    setExtensionsState(
      stateOf([
        entry({
          status: "disabled",
          enabled: false,
          capabilities: ["ui", "process", "gates"],
        }),
      ]),
    );
    const { calls } = serve({
      "ext.config.get": () => ({ schema: {}, values: {} }),
      "ext.logs": () => ({ lines: [] }),
      "ext.manage": (params) =>
        params.op === "consent"
          ? {
              summary: summary({
                capabilities: [
                  { id: "ui", risk: "low" },
                  { id: "process", risk: "high" },
                  { id: "gates", risk: "medium" },
                ],
              }),
              diff: noDiff,
              needs_consent: true,
            }
          : {},
    });
    await mount(h(ExtensionsSettings));
    await openRow("CI badges");
    await click("Enable");
    await flush();
    const ops = () => calls.map((c) => c.params.op);
    expect(ops()).not.toContain("enable");
    expect(container.querySelector(".ext-risk-high")?.textContent).toContain(
      "process",
    );
    expect(container.querySelector(".ext-risk-medium")?.textContent).toContain(
      "gates",
    );
    expect(container.textContent).toContain("not sandboxed");
    await click("Enable");
    await flush();
    expect(calls.slice(-2).map((c) => c.params)).toEqual([
      { op: "consent", id: "acme.ci", accept: true },
      { op: "enable", id: "acme.ci" },
    ]);
  });

  test("install previews the consent summary and applies only after confirming", async () => {
    setExtensionsState(stateOf([]));
    const { calls } = serve({
      "ext.install.preview": () => ({
        preview_id: "p1",
        installed_version: "1.0.0",
        summary: summary({
          id: "acme.new",
          name: "New one",
          version: "2.0.0",
          source: {
            kind: "github",
            location: "acme/new",
            resolved: "a".repeat(40),
          },
          capabilities: [
            { id: "ui", risk: "low" },
            { id: "terminal.write", risk: "high" },
            { id: "terminal.read", risk: "medium" },
          ],
          events: ["terminal.submit"],
          hooks: [{ on: "pane.close", command: ["sh", "g.sh"] }],
          routes: ["webhook permission"],
          network_hosts: ["api.example.com"],
          imports: ["node:fs"],
          unreadable: ["on(eventName)"],
        }),
        diff: {
          capabilities: { added: ["terminal.write"], removed: [] },
          events: { added: [], removed: [] },
          hooks: { added: [], removed: ["old hook"] },
          routes: { added: ["proxy /"], removed: [] },
          imports: { added: [], removed: [] },
        },
      }),
      "ext.install.apply": () => ({}),
    });
    await mount(h(ExtensionsSettings));
    await click("Install extension");
    expect(button("Review").disabled).toBe(true);
    await type(
      container.querySelector<HTMLInputElement>("#ext-install-source")!,
      "acme/new",
    );
    await click("Review");
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["ext.install.preview"]);
    expect(calls[0].params).toEqual({ source: "acme/new" });
    const text = container.textContent ?? "";
    expect(text).toContain("New one 2.0.0");
    expect(text).toContain("github: acme/new");
    expect(text).toContain("a".repeat(40));
    expect(text).toContain("Changes since 1.0.0");
    expect(text).toContain("routes: proxy /");
    expect(text).toContain("hooks: old hook");
    expect(text).toContain("pane.close: sh g.sh");
    expect(text).toContain("on(eventName)");
    expect(text).toContain("api.example.com");
    const risks = [...container.querySelectorAll(".ext-consent-risk")].map(
      (group) => group.className,
    );
    expect(risks).toEqual([
      "ext-consent-risk ext-risk-high",
      "ext-consent-risk ext-risk-medium",
      "ext-consent-risk ext-risk-low",
    ]);

    await click("Cancel");
    expect(calls.length).toBe(1);
    expect(container.querySelector("#ext-install-source")).not.toBeNull();
    await click("Review");
    await flush();
    await click("Update");
    await flush();
    expect(calls[calls.length - 1]).toEqual({
      method: "ext.install.apply",
      params: { preview_id: "p1" },
    });
    expect(container.textContent).toContain("No extensions installed.");
  });

  test("install surfaces a preview failure and installs nothing", async () => {
    setExtensionsState(stateOf([]));
    const { calls } = serve({
      "ext.install.preview": () => {
        throw new Error("git clone failed");
      },
    });
    await mount(h(ExtensionsSettings));
    await click("Install extension");
    await type(
      container.querySelector<HTMLInputElement>("#ext-install-source")!,
      "acme/missing",
    );
    await click("Review");
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "git clone failed",
    );
    expect(calls.map((c) => c.method)).toEqual(["ext.install.preview"]);
  });

  test("notices cover safe mode and auto-disabled extensions, dismiss, and link to the tab", async () => {
    const state = stateOf(
      [
        entry({
          id: "x",
          name: "Flaky",
          status: "failed",
          enabled: false,
          last_error: { at: 9, message: "boom" },
        }),
      ],
      true,
    );
    expect(extensionNotices(stateOf([]), [])).toEqual([]);
    expect(extensionNotices(stateOf([], true), [])).toEqual([]);
    expect(extensionNotices(state, []).map((item) => item.key)).toEqual([
      "safe-mode",
      "failed:x:9",
    ]);
    expect(
      extensionNotices(state, ["safe-mode"]).map((item) => item.key),
    ).toEqual(["failed:x:9"]);

    let opened = 0;
    await mount(h(ExtensionNotices, { onOpen: () => (opened += 1) }));
    expect(container.textContent).toBe("");
    await act(async () => setExtensionsState(state));
    expect(container.textContent).toContain("Extensions are off (safe mode)");
    expect(container.textContent).toContain("Flaky was disabled");
    expect(container.textContent).toContain("boom");
    await click("Open Extensions");
    expect(opened).toBe(1);
    await click("Dismiss");
    expect(container.textContent).not.toContain("safe mode");
    expect(container.textContent).toContain("Flaky was disabled");
  });

  test("the slot gate opens the chunk only for an enabled or held extension", async () => {
    await mount(h(ExtensionSlot, { slot: "notices" }));
    expect(container.innerHTML).toBe("");
    await act(async () => syncExtensionsGate(stateOf([])));
    await act(async () =>
      syncExtensionsGate(
        stateOf([entry({ enabled: false, status: "disabled" })]),
      ),
    );
    expect(container.innerHTML).toBe("");
    // Opening the gate loads the chunk, whose notices then explain safe mode.
    const held = stateOf([entry({ status: "safe_mode" })], true);
    await act(async () => syncExtensionsGate(held));
    await act(async () => {
      await import("./index");
    });
    await act(async () => setExtensionsState(held));
    await flush();
    expect(container.textContent).toContain("Extensions are off (safe mode)");
  });

  test("Configuration has an Extensions tab backed by the mocked ext.state", async () => {
    const { ConfigurationDialog } = await import(
      "../components/ConfigurationDialog"
    );
    const {
      defaultMobileTerminalShortcutRows,
      defaultMobileTerminalSideShortcuts,
    } = await import("../mobileTerminalShortcuts");
    setExtensionsState(stateOf([entry({ status: "safe_mode" })], true));
    const noop = () => {};
    await mount(
      h(ConfigurationDialog, {
        initialTab: "Extensions",
        onClose: noop,
        theme: "system",
        accentColor: "blue",
        uiScale: 100,
        terminalFontScale: 100,
        terminalFontName: "monospace",
        mobileTerminalShortcuts: defaultMobileTerminalShortcutRows(),
        mobileTerminalSideShortcuts: defaultMobileTerminalSideShortcuts(),
        terminalThemeSelection: { dark: "herdr-dark", light: "herdr-light" },
        customTerminalThemes: [],
        onThemeChange: noop,
        blackBackground: false,
        onBlackBackgroundChange: noop,
        onAccentColorChange: noop,
        onUiScaleChange: noop,
        onTerminalFontScaleChange: noop,
        onTerminalFontNameChange: noop,
        onMobileTerminalShortcutsChange: noop,
        onMobileTerminalSideShortcutsChange: noop,
        onTerminalThemeSelectionChange: noop,
        onCustomTerminalThemesChange: noop,
      }),
    );
    const tab = container.querySelector("#configuration-tab-Extensions");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
    const panel = container.querySelector<HTMLElement>(
      "#configuration-panel-Extensions",
    );
    expect(panel?.hidden).toBe(false);
    // The tab body is lazy; loading its module resolves the Suspense boundary.
    await act(async () => {
      await import("./index");
    });
    await flush();
    expect(panel?.querySelector(".ext-banner")?.textContent).toContain(
      "Safe mode is on",
    );
    expect(panel?.textContent).toContain("CI badges");
  });

  test("the Extensions tab loads on its own with zero extensions and can install", async () => {
    const { ConfigurationDialog } = await import(
      "../components/ConfigurationDialog"
    );
    const {
      defaultMobileTerminalShortcutRows,
      defaultMobileTerminalSideShortcuts,
    } = await import("../mobileTerminalShortcuts");
    const { resetExtensionsMirror } = await import("./state");
    resetExtensionsMirror();
    // No ExtensionSlot is mounted and no state is seeded: only a connected status.
    spyOn(bridge, "onStatus").mockImplementation((cb) => {
      cb("connected");
      return () => true;
    });
    const { calls } = serve({ "ext.state": () => stateOf([]) });
    const noop = () => {};
    await mount(
      h(ConfigurationDialog, {
        initialTab: "Extensions",
        onClose: noop,
        theme: "system",
        accentColor: "blue",
        uiScale: 100,
        terminalFontScale: 100,
        terminalFontName: "monospace",
        mobileTerminalShortcuts: defaultMobileTerminalShortcutRows(),
        mobileTerminalSideShortcuts: defaultMobileTerminalSideShortcuts(),
        terminalThemeSelection: { dark: "herdr-dark", light: "herdr-light" },
        customTerminalThemes: [],
        onThemeChange: noop,
        blackBackground: false,
        onBlackBackgroundChange: noop,
        onAccentColorChange: noop,
        onUiScaleChange: noop,
        onTerminalFontScaleChange: noop,
        onTerminalFontNameChange: noop,
        onMobileTerminalShortcutsChange: noop,
        onMobileTerminalSideShortcutsChange: noop,
        onTerminalThemeSelectionChange: noop,
        onCustomTerminalThemesChange: noop,
      }),
    );
    await act(async () => {
      await import("./index");
    });
    await flush();
    await flush();
    expect(calls.map((c) => c.method)).toContain("ext.state");
    const panel = container.querySelector<HTMLElement>(
      "#configuration-panel-Extensions",
    );
    expect(panel?.textContent).toContain("No extensions installed.");
    expect(panel?.textContent).not.toContain("not available");
    await click("Install extension");
    expect(container.querySelector("#ext-install-source")).not.toBeNull();
  });

  test("an older server shows the tab as unavailable instead of empty", async () => {
    const { resetExtensionsMirror } = await import("./state");
    resetExtensionsMirror();
    spyOn(bridge, "onStatus").mockImplementation((cb) => {
      cb("connected");
      return () => true;
    });
    serve({
      "ext.state": () => {
        throw new Error("unknown method");
      },
    });
    await mount(h(ExtensionsSettings));
    await flush();
    expect(container.textContent).toContain("not available on this server");
  });

  test("marketplace entries install only through the consent review, at their pin", async () => {
    setExtensionsState(stateOf([]));
    const pin = "b".repeat(40);
    const { calls } = serve({
      "ext.marketplace.list": () => ({
        marketplaces: [
          {
            name: "acme",
            source: "acme/exts",
            kind: "github",
            added_at: 1,
            refreshed_at: 2,
            entries: 1,
          },
        ],
      }),
      "ext.marketplace.browse": () => ({
        entries: [
          {
            marketplace: "acme",
            id: "acme.pinned",
            name: "Pinned",
            description: "Listed at a commit",
            version: "1.0.0",
            source: "acme/pinned",
            ref: pin,
            tags: ["ci"],
            install: { source: "acme/pinned", ref: pin },
            installed: null,
          },
        ],
      }),
      "ext.install.preview": () => ({
        preview_id: "p9",
        summary: summary({ id: "acme.pinned", name: "Pinned" }),
      }),
      "ext.install.apply": () => ({}),
    });
    await mount(h(ExtensionsSettings));
    await click("Marketplaces");
    await flush();
    expect(container.textContent).toContain("Pinned");
    expect(container.textContent).toContain("Not installed");
    expect(calls.map((c) => c.method)).not.toContain("ext.install.apply");

    await click("Review install");
    const input = container.querySelector<HTMLInputElement>(
      "#ext-install-source",
    );
    expect(input?.value).toBe("acme/pinned");
    await click("Review");
    await flush();
    expect(calls[calls.length - 1]).toEqual({
      method: "ext.install.preview",
      params: { source: "acme/pinned", ref: pin },
    });
    expect(calls.map((c) => c.method)).not.toContain("ext.install.apply");
    await click("Install");
    await flush();
    expect(calls[calls.length - 1].method).toBe("ext.install.apply");
  });
}
