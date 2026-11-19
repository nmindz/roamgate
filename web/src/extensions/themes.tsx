import { useEffect, useSyncExternalStore } from "react";
import type {
  ExtensionContributions,
  ExtensionStateResult,
} from "../../../shared/extensions";
import { addListener } from "../../../shared/listeners";
import { roamgateLocalStorage } from "../browserStorage";
import { setExtensionContributions } from "../extensionsBootstrap";
import {
  type CustomTerminalTheme,
  normalizeCustomTerminalTheme,
} from "../terminalThemes";
import { useExtensionsState } from "./state";

type ThemeEntry = NonNullable<ExtensionContributions["themes"]>[number];

/** Tokens an accent palette may override; nothing else in the app's theme can change. */
export const ACCENT_TOKENS = [
  "--accent",
  "--accent-2",
  "--accent-soft",
  "--accent-hover",
  "--accent-active",
  "--accent-contrast",
] as const;

const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9\s.,%/deg-]+\))$/i;

export interface AccentTheme {
  id: string;
  name: string;
  /** Applied on every theme; `light` and `dark` add to them. */
  tokens: Record<string, string>;
  variants: Record<"light" | "dark", Record<string, string>>;
}

function themeId(ext: string, entry: ThemeEntry): string {
  const base =
    entry.id ??
    entry.file
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ??
    "theme";
  return `ext:${ext}:${base.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "theme"}`;
}

/** Terminal themes of enabled extensions; unreadable files are skipped. */
export function terminalThemesFromState(
  state: ExtensionStateResult | null,
): CustomTerminalTheme[] {
  if (!state || state.safe_mode) return [];
  return state.extensions.flatMap((extension) =>
    !extension.enabled
      ? []
      : (extension.contributions.themes ?? []).flatMap((entry) => {
          if (entry.kind !== "terminal") return [];
          const theme = normalizeCustomTerminalTheme(entry.data, 0, new Set());
          return theme
            ? [
                {
                  ...theme,
                  id: themeId(extension.id, entry),
                  name: entry.name ?? theme.name,
                },
              ]
            : [];
        }),
  );
}

function tokenMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const name of ACCENT_TOKENS) {
    const color = (value as Record<string, unknown>)[name];
    if (typeof color === "string" && SAFE_COLOR.test(color.trim()))
      result[name] = color.trim();
  }
  return result;
}

/** Accent palettes of enabled extensions: `{ tokens, light?, dark? }` of colours. */
export function accentThemesFromState(
  state: ExtensionStateResult | null,
): AccentTheme[] {
  if (!state || state.safe_mode) return [];
  return state.extensions.flatMap((extension) =>
    !extension.enabled
      ? []
      : (extension.contributions.themes ?? []).flatMap((entry) => {
          if (entry.kind !== "accent") return [];
          const data = (entry.data ?? {}) as Record<string, unknown>;
          const tokens = tokenMap(data.tokens);
          const variants = {
            light: tokenMap(data.light),
            dark: tokenMap(data.dark),
          };
          if (
            Object.keys(tokens).length +
              Object.keys(variants.light).length +
              Object.keys(variants.dark).length ===
            0
          )
            return [];
          return [
            {
              id: themeId(extension.id, entry),
              name: entry.name ?? entry.id ?? entry.file,
              tokens,
              variants,
            },
          ];
        }),
  );
}

const ACCENT_KEY = "extensionAccent.v1";
const accentListeners = new Set<() => void>();

export const readAccentChoice = () =>
  roamgateLocalStorage.getItem(ACCENT_KEY) ?? "";

export function chooseAccent(id: string) {
  if (id) roamgateLocalStorage.setItem(ACCENT_KEY, id);
  else roamgateLocalStorage.removeItem(ACCENT_KEY);
  accentListeners.forEach((listener) => listener());
}

export const useAccentChoice = () =>
  useSyncExternalStore(
    (listener) => addListener(accentListeners, listener),
    readAccentChoice,
    readAccentChoice,
  );

/** Sets the chosen palette's tokens on `root` and clears every other accent token. */
export function applyAccentTheme(
  root: HTMLElement,
  theme: AccentTheme | undefined,
  resolved: "light" | "dark",
) {
  for (const name of ACCENT_TOKENS) root.style.removeProperty(name);
  if (!theme) return;
  for (const [name, value] of Object.entries({
    ...theme.tokens,
    ...theme.variants[resolved],
  }))
    root.style.setProperty(name, value);
}

/** Keeps the app's themes in step with the enabled extensions. Renders nothing. */
export function ThemesView() {
  const state = useExtensionsState();
  const choice = useAccentChoice();
  useEffect(() => {
    setExtensionContributions({
      terminalThemes: terminalThemesFromState(state),
    });
    return () => setExtensionContributions({ terminalThemes: [] });
  }, [state]);
  useEffect(() => {
    const root = document.documentElement;
    const theme = accentThemesFromState(state).find(
      (item) => item.id === choice,
    );
    const apply = () =>
      applyAccentTheme(
        root,
        theme,
        root.dataset.theme === "light" ? "light" : "dark",
      );
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      observer.disconnect();
      applyAccentTheme(root, undefined, "dark");
    };
  }, [state, choice]);
  return null;
}

/** Appearance: palettes extensions ship, next to the built-in accent colours. */
export function AppearanceThemes() {
  const state = useExtensionsState();
  const choice = useAccentChoice();
  const themes = accentThemesFromState(state);
  if (themes.length === 0) return null;
  return (
    <div className="config-preference-row ext-accent-row">
      <div className="config-item-copy">
        <strong>Extension accents</strong>
        <span>Palettes from enabled extensions</span>
      </div>
      <div
        className="config-theme-control"
        role="radiogroup"
        aria-label="Extension accent"
      >
        {[{ id: "", name: "None" }, ...themes].map((theme) => (
          <button
            key={theme.id || "none"}
            type="button"
            role="radio"
            aria-checked={choice === theme.id}
            className={choice === theme.id ? "is-active" : undefined}
            onClick={() => chooseAccent(theme.id)}
          >
            {theme.name}
          </button>
        ))}
      </div>
    </div>
  );
}
