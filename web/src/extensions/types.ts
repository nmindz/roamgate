import type { ComponentType } from "react";
import type { Pane, Tab, Workspace } from "../types";

/** What the core passes to an extension slot: the entities a row or pane stands for. */
export interface SlotTarget {
  workspace?: Workspace;
  tab?: Tab;
  pane?: Pane;
  /** Ids for callers that hold no entity, such as the composer. */
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  agent?: string;
}

export interface HostProps extends SlotTarget {
  slot: string;
  /** Palette search text, for slots that list filterable items. */
  search?: string;
  /** Runs after an item ran its command, for menus and popovers that close. */
  onRun?: () => void;
  /** Opens Configuration > Extensions. */
  onOpen?: () => void;
  /** Inspector: the `ext:<id>:<entry>` view being shown. */
  view?: string;
  /** Inspector tabs: switches to an extension view. */
  onSelect?: (view: string) => void;
  /** Inspector panel: the view's extension or entry is gone. */
  onMissing?: () => void;
  /** Receives the composer commands an extension contributes. */
  onItems?: (items: ComposerItem[]) => void;
}

export type HostView = ComponentType<HostProps>;

export interface ComposerItem {
  name: string;
  description: string;
  arguments?: string;
  expand?: string;
}

export type ApprovalRisk = "low" | "medium" | "high";

/** Mirrors the bridge's pending ask (`{extensions:{approvals:[...]}}`). */
export interface PendingApproval {
  id: string;
  ext: string;
  event: string;
  summary: string;
  target: {
    connection_id?: string;
    generation?: number;
    connection_label?: string;
    workspace_id?: string;
    workspace_label?: string;
    pane_id?: string;
  };
  origin: string;
  reason?: string;
  detail?: string;
  risk?: ApprovalRisk;
  /** Epoch milliseconds. */
  deadline?: number;
  on_timeout?: "deny" | "allow";
}

export type ApprovalDecision = "approve" | "deny";
