import { useState } from "react";
import type { ExtensionStateResult } from "../../../shared/extensions";
import { roamgateSessionStorage } from "../browserStorage";
import { useExtensionsState } from "./state";

const DISMISSED_KEY = "roamgate:extension-notices-dismissed";

function readDismissed(): string[] {
  try {
    const parsed = JSON.parse(
      roamgateSessionStorage.getItem(DISMISSED_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface NoticeItem {
  key: string;
  text: string;
  detail?: string;
}

export function extensionNotices(
  state: ExtensionStateResult,
  dismissed: readonly string[],
): NoticeItem[] {
  const items: NoticeItem[] = [];
  if (state.safe_mode && state.extensions.length > 0)
    items.push({
      key: "safe-mode",
      text: "Extensions are off (safe mode). None of them is loaded.",
    });
  for (const entry of state.extensions) {
    if (entry.status !== "failed" || !entry.last_error) continue;
    items.push({
      key: `failed:${entry.id}:${entry.last_error.at}`,
      text: `${entry.name} was disabled after repeated failures.`,
      detail: entry.last_error.message,
    });
  }
  return items.filter((item) => !dismissed.includes(item.key));
}

/** Dismissible safe-mode and auto-disable notices that link to the Extensions tab. */
export function ExtensionNotices({ onOpen }: { onOpen?: () => void }) {
  const state = useExtensionsState();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!state) return null;
  const items = extensionNotices(state, dismissed);
  if (items.length === 0) return null;
  const dismiss = (key: string) => {
    const next = [...dismissed, key];
    roamgateSessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    setDismissed(next);
  };
  return (
    <div className="ext-notices" aria-live="polite">
      {items.map((item) => (
        <div key={item.key} className="ext-notice" role="status">
          <div className="ext-notice-copy">
            <strong>{item.text}</strong>
            {item.detail ? <span>{item.detail}</span> : null}
          </div>
          <button type="button" onClick={onOpen}>
            Open Extensions
          </button>
          <button type="button" onClick={() => dismiss(item.key)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
