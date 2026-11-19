import { describe, expect, test } from "bun:test";
import type {
  ExtensionStateEntry,
  ExtensionStateResult,
} from "../../../shared/extensions";
import {
  ACCENT_TOKENS,
  accentThemesFromState,
  applyAccentTheme,
  terminalThemesFromState,
} from "./themes";

function stateWith(
  data: unknown,
  patch: Partial<ExtensionStateEntry> = {},
  safe_mode = false,
): ExtensionStateResult {
  return {
    safe_mode,
    api: "1.0",
    extensions: [
      {
        id: "acme.look",
        name: "Look",
        version: "1.0.0",
        status: "active",
        enabled: true,
        capabilities: [],
        contributions: {
          commands: [],
          slots: [],
          keybindings: [],
          themes: [
            { kind: "accent", file: "./accent.json", name: "Dusk", data },
          ],
        },
        ...patch,
      } as ExtensionStateEntry,
    ],
  };
}

describe("accent palettes", () => {
  test("keep only documented colour tokens with plain colour values", () => {
    const [theme] = accentThemesFromState(
      stateWith({
        tokens: {
          "--accent": "#112233",
          "--accent-soft": "rgba(1, 2, 3, 0.2)",
          "--bg": "#000000",
          "--panel": "red",
          "--accent-hover": "url(https://evil.example/x)",
          "--accent-active": "#fff; background: red",
          "--accent-2": 12,
        },
        dark: { "--accent-contrast": "hsl(210, 20%, 90%)", "--text": "#fff" },
        light: { "--shadow-lg": "0 0 9px red" },
      }),
    );
    expect(theme.tokens).toEqual({
      "--accent": "#112233",
      "--accent-soft": "rgba(1, 2, 3, 0.2)",
    });
    expect(theme.variants.dark).toEqual({
      "--accent-contrast": "hsl(210, 20%, 90%)",
    });
    expect(theme.variants.light).toEqual({});
  });

  test("a palette with nothing allowed is dropped", () => {
    expect(
      accentThemesFromState(stateWith({ tokens: { "--bg": "#000" } })),
    ).toEqual([]);
  });

  test("disabled extensions and safe mode contribute nothing", () => {
    const data = { tokens: { "--accent": "#123456" } };
    expect(accentThemesFromState(stateWith(data, { enabled: false }))).toEqual(
      [],
    );
    expect(accentThemesFromState(stateWith(data, {}, true))).toEqual([]);
    expect(terminalThemesFromState(stateWith(data, {}, true))).toEqual([]);
  });

  test("applying sets only allowed tokens and clears the previous palette", () => {
    const set: Record<string, string> = {};
    const root = {
      style: {
        setProperty: (name: string, value: string) => {
          set[name] = value;
        },
        removeProperty: (name: string) => {
          delete set[name];
        },
      },
    } as unknown as HTMLElement;
    const [theme] = accentThemesFromState(
      stateWith({
        tokens: { "--accent": "#112233", "--bg": "#000" },
        light: { "--accent": "#445566" },
      }),
    );
    applyAccentTheme(root, theme, "dark");
    expect(set).toEqual({ "--accent": "#112233" });
    applyAccentTheme(root, theme, "light");
    expect(set).toEqual({ "--accent": "#445566" });
    applyAccentTheme(root, undefined, "dark");
    expect(set).toEqual({});
    expect(ACCENT_TOKENS).not.toContain("--bg" as never);
  });
});
