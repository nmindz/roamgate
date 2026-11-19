import { useEffect } from "react";
import { installKeybindings } from "./dynamicShortcuts";

/** Mounted once by the app: keeps the dynamic shortcut listener alive. */
export function KeybindingsView() {
  useEffect(installKeybindings, []);
  return null;
}
