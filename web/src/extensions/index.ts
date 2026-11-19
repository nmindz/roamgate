import { createElement, Fragment } from "react";
import { ExtensionNotices } from "./ExtensionNotices";
import css from "./extensions.css?raw";
import {
  BadgesView,
  ComposerView,
  ContextMenuView,
  ExtensionToasts,
  InspectorPanelView,
  InspectorTabsView,
  MenuItemsView,
  PaletteView,
  PaneOverlayView,
  PaneToolbarView,
  SidebarSectionView,
  StatusBarView,
  TopbarView,
} from "./views";
import { BootView } from "./BootView";
import { AppearanceThemes } from "./themes";
import type { HostProps } from "./types";

export { ExtensionsSettings } from "./ExtensionsSettings";
export { ShortcutSettings } from "./ShortcutSettings";
export { PreviewFrame } from "./PreviewFrame";

/** Entry of the lazy chunk behind `ExtensionSlot`: one view per slot. */
export function ExtensionsHost(props: HostProps) {
  const { slot } = props;
  if (slot === "notices")
    return createElement(
      Fragment,
      null,
      createElement(ExtensionNotices, { onOpen: props.onOpen }),
      createElement(ExtensionToasts),
      createElement(BootView),
    );
  if (slot.endsWith(".badge")) return createElement(BadgesView, props);
  if (slot.startsWith("context-menu."))
    return createElement(ContextMenuView, props);
  const view = {
    appearance: AppearanceThemes,
    topbar: TopbarView,
    "menu.item": MenuItemsView,
    "sidebar.section": SidebarSectionView,
    "statusbar.item": StatusBarView,
    "pane.toolbar": PaneToolbarView,
    "pane.overlay": PaneOverlayView,
    "composer.command": ComposerView,
    command: PaletteView,
    "inspector.tabs": InspectorTabsView,
    "inspector.panel": InspectorPanelView,
  }[slot];
  return view ? createElement(view, props) : null;
}

export default ExtensionsHost;

// Injected rather than bundled as a CSS file, so the asset-file budget is untouched.
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
