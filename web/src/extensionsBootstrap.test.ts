import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  ExtensionStateEntry,
  ExtensionStateResult,
  ExtensionsPush,
} from "../../shared/extensions";
import type { ConnectionStatus } from "./api";
import {
  extensionsGateOpen,
  initExtensionsGate,
  needsExtensionsChunk,
  syncExtensionsGate,
} from "./extensionsBootstrap";

function entry(patch: Partial<ExtensionStateEntry> = {}): ExtensionStateEntry {
  return {
    id: "acme.ci",
    name: "CI",
    version: "1.0.0",
    status: "idle",
    enabled: true,
    capabilities: [],
    contributions: { commands: [], slots: [], keybindings: [] },
    ...patch,
  };
}

function stateOf(
  extensions: ExtensionStateEntry[],
  safe_mode = false,
): ExtensionStateResult {
  return { safe_mode, api: "1.0", extensions };
}

afterEach(() => syncExtensionsGate(null));

describe("needsExtensionsChunk", () => {
  test("never loads without state or without installed extensions", () => {
    expect(needsExtensionsChunk(null)).toBe(false);
    expect(needsExtensionsChunk({ safe_mode: false })).toBe(false);
    expect(needsExtensionsChunk(stateOf([]))).toBe(false);
    expect(needsExtensionsChunk(stateOf([], true))).toBe(false);
  });

  test("never loads for extensions that are only installed and off", () => {
    expect(
      needsExtensionsChunk(
        stateOf([
          entry({ enabled: false, status: "disabled" }),
          entry({ id: "b", enabled: false, status: "invalid" }),
        ]),
      ),
    ).toBe(false);
  });

  test("loads for an enabled extension, including one held by safe mode", () => {
    expect(needsExtensionsChunk(stateOf([entry()]))).toBe(true);
    expect(
      needsExtensionsChunk(stateOf([entry({ status: "safe_mode" })], true)),
    ).toBe(true);
  });

  test("loads to explain an auto-disabled extension", () => {
    expect(
      needsExtensionsChunk(
        stateOf([entry({ enabled: false, status: "failed" })]),
      ),
    ).toBe(true);
  });
});

describe("initExtensionsGate", () => {
  // Captures the handlers the gate registers so tests can fire them.
  function fakeSource(call: (method: string) => Promise<unknown>) {
    let onStatus: (status: ConnectionStatus) => void = () => {};
    let onPush: (push: ExtensionsPush) => void = () => {};
    return {
      source: {
        call: mock(call),
        onStatus: (cb: (status: ConnectionStatus) => void) => {
          onStatus = cb;
          return () => true;
        },
        onExtensions: (cb: (push: ExtensionsPush) => void) => {
          onPush = cb;
          return () => true;
        },
      } as unknown as Parameters<typeof initExtensionsGate>[0],
      status: (status: ConnectionStatus) => onStatus(status),
      push: (push: ExtensionsPush) => onPush(push),
    };
  }

  test("connecting fetches ext.state; state pushes drive the gate", async () => {
    const { source, status, push } = fakeSource(async () => stateOf([entry()]));
    initExtensionsGate(source);
    status("connecting");
    expect(source.call).not.toHaveBeenCalled();
    status("connected");
    await Promise.resolve();
    await Promise.resolve();
    expect(source.call).toHaveBeenCalledWith("ext.state");
    expect(extensionsGateOpen()).toBe(true);
    push({ invalidate: { ext: "a", slot: "toast" } });
    push({ approvals: [] });
    expect(extensionsGateOpen()).toBe(true);
    push({ state: stateOf([entry({ enabled: false, status: "disabled" })]) });
    expect(extensionsGateOpen()).toBe(false);
    push({ state: stateOf([entry()]) });
    expect(extensionsGateOpen()).toBe(true);
  });

  test("a server that rejects ext.state leaves the gate known and closed", async () => {
    const { source, status } = fakeSource(async () => {
      throw new Error("unknown method");
    });
    initExtensionsGate(source);
    syncExtensionsGate(stateOf([entry()]));
    expect(extensionsGateOpen()).toBe(true);
    status("connected");
    await Promise.resolve();
    await Promise.resolve();
    expect(extensionsGateOpen()).toBe(false);
  });
});
