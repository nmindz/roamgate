import { useState } from "react";
import { useExtensionsState } from "./state";
import type { MarketplaceInstallParams } from "../../../shared/extensions";
import { ConsentView } from "./ConsentView";
import { Marketplaces } from "./Marketplaces";
import { ExtensionPage, STATUS_TEXT } from "./ExtensionPage";
import {
  extInstallApply,
  extInstallPreview,
  type InstallPreview,
  extManage,
} from "./rpc";

function InstallFlow({
  initial,
  onDone,
}: {
  initial?: MarketplaceInstallParams;
  onDone: () => void;
}) {
  const [source, setSource] = useState(initial?.source ?? "");
  const [ref, setRef] = useState(initial?.ref ?? "");
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refValue = ref.trim() || undefined;

  const review = () => {
    setBusy(true);
    setError("");
    extInstallPreview(source.trim(), refValue, initial?.sha256).then(
      (result) => {
        setBusy(false);
        setPreview(result);
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  const install = () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    extInstallApply(preview.preview_id).then(
      () => {
        setBusy(false);
        onDone();
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };

  return (
    <div className="ext-install">
      {preview ? (
        <ConsentView
          summary={preview.summary}
          diff={preview.diff}
          installedVersion={preview.installed_version}
          confirmLabel={preview.installed_version ? "Update" : "Install"}
          busy={busy}
          onCancel={() => setPreview(null)}
          onConfirm={install}
        />
      ) : (
        <form
          className="ext-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
        >
          <div className="ext-field">
            <label htmlFor="ext-install-source">Source</label>
            <input
              id="ext-install-source"
              value={source}
              placeholder="owner/repo, git URL, or archive URL"
              onChange={(event) => setSource(event.target.value)}
            />
            <span className="muted">
              Nothing is installed until you review and confirm what it can do.
            </span>
          </div>
          <div className="ext-field">
            <label htmlFor="ext-install-ref">Commit (optional)</label>
            <input
              id="ext-install-ref"
              value={ref}
              placeholder="40-character commit SHA"
              onChange={(event) => setRef(event.target.value)}
            />
          </div>
          <div className="ext-actions">
            <button type="button" onClick={onDone} disabled={busy}>
              Cancel
            </button>
            <button type="submit" disabled={busy || source.trim() === ""}>
              {busy ? "Reading..." : "Review"}
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p className="ext-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type View =
  | { kind: "list" }
  | { kind: "market" }
  | { kind: "install"; initial?: MarketplaceInstallParams }
  | { kind: "page"; id: string };

export function ExtensionsSettings() {
  const state = useExtensionsState();
  const [view, setView] = useState<View>({ kind: "list" });
  const [error, setError] = useState("");

  if (!state)
    return (
      <p className="muted ext-unavailable">
        Extensions are not available on this server.
      </p>
    );

  const page =
    view.kind === "page"
      ? state.extensions.find((entry) => entry.id === view.id)
      : undefined;
  if (page)
    return (
      <ExtensionPage
        entry={page}
        ids={state.extensions.map((entry) => entry.id)}
        onBack={() => setView({ kind: "list" })}
      />
    );
  if (view.kind === "install")
    return (
      <InstallFlow
        initial={view.initial}
        onDone={() => setView({ kind: "list" })}
      />
    );
  if (view.kind === "market")
    return (
      <Marketplaces
        onBack={() => setView({ kind: "list" })}
        onInstall={(initial) => setView({ kind: "install", initial })}
      />
    );

  const failed = state.extensions.filter(
    (entry) => entry.status === "failed" && entry.last_error,
  );
  return (
    <div className="ext-settings">
      {state.safe_mode ? (
        <div className="ext-banner" role="status">
          <div>
            <strong>Safe mode is on</strong>
            <span>Extensions are not loaded and nothing of theirs runs.</span>
          </div>
          <button
            type="button"
            onClick={() =>
              extManage({ op: "safe_mode", enabled: false }).catch((e: Error) =>
                setError(e.message),
              )
            }
          >
            Turn off safe mode
          </button>
        </div>
      ) : null}
      {failed.map((entry) => (
        <div
          key={entry.id}
          className="ext-banner ext-banner-danger"
          role="status"
        >
          <div>
            <strong>{entry.name} was disabled after repeated failures</strong>
            <span>{entry.last_error?.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setView({ kind: "page", id: entry.id })}
          >
            Review
          </button>
        </div>
      ))}
      {error ? (
        <p className="ext-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="ext-toolbar">
        <span className="muted">
          {state.extensions.length === 0
            ? "No extensions installed."
            : `${state.extensions.length} installed`}
        </span>
        <button type="button" onClick={() => setView({ kind: "install" })}>
          Install extension
        </button>
        <button type="button" onClick={() => setView({ kind: "market" })}>
          Marketplaces
        </button>
      </div>
      <ul className="ext-rows">
        {state.extensions.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="ext-row"
              onClick={() => setView({ kind: "page", id: entry.id })}
            >
              <span className="ext-row-head">
                <strong>{entry.name}</strong>
                <span className="muted">{entry.version}</span>
                <span className={`badge ext-status ext-status-${entry.status}`}>
                  {STATUS_TEXT[entry.status]}
                </span>
              </span>
              {entry.capabilities.length > 0 ? (
                <span className="ext-chips">
                  {entry.capabilities.map((capability) => (
                    <span key={capability} className="badge ext-chip">
                      {capability}
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
