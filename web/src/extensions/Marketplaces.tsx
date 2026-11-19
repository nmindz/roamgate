import { useCallback, useEffect, useState } from "react";
import type {
  MarketplaceBrowseEntry,
  MarketplaceInfo,
  MarketplaceInstallParams,
} from "../../../shared/extensions";
import {
  marketplaceAdd,
  marketplaceBrowse,
  marketplaceList,
  marketplaceRefresh,
  marketplaceRemove,
} from "./rpc";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function entryStatus(entry: MarketplaceBrowseEntry): string {
  const installed = entry.installed;
  if (!installed) return "Not installed";
  if (installed.update_available)
    return `Installed ${installed.version}, update listed`;
  return `Installed ${installed.version}`;
}

/**
 * Browse added catalogs and pick an entry. Picking only starts the usual
 * consent review; a catalog never installs or enables anything by itself.
 */
export function Marketplaces({
  onInstall,
  onBack,
}: {
  onInstall: (params: MarketplaceInstallParams) => void;
  onBack: () => void;
}) {
  const [catalogs, setCatalogs] = useState<MarketplaceInfo[]>([]);
  const [entries, setEntries] = useState<MarketplaceBrowseEntry[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [list, browse] = await Promise.all([
      marketplaceList(),
      marketplaceBrowse(),
    ]);
    setCatalogs(list);
    setEntries(browse);
  }, []);

  useEffect(() => {
    let current = true;
    load().catch((e) => current && setError(messageOf(e)));
    return () => {
      current = false;
    };
  }, [load]);

  const run = (work: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setError("");
    work()
      .then(load)
      .then(done)
      .catch((e) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="ext-market">
      <div className="ext-toolbar">
        <strong>Marketplaces</strong>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
      <form
        className="ext-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          run(
            () => marketplaceAdd(source.trim()),
            () => setSource(""),
          );
        }}
      >
        <div className="ext-field">
          <label htmlFor="ext-market-source">Add a catalog</label>
          <input
            id="ext-market-source"
            value={source}
            placeholder="owner/repo, git URL, or https URL"
            onChange={(event) => setSource(event.target.value)}
          />
          <span className="muted">
            A catalog only lists extensions. Installing one still shows what it
            can do first.
          </span>
        </div>
        <div className="ext-actions">
          <button
            type="button"
            disabled={busy || catalogs.length === 0}
            onClick={() => run(() => marketplaceRefresh())}
          >
            Refresh all
          </button>
          <button type="submit" disabled={busy || source.trim() === ""}>
            Add
          </button>
        </div>
      </form>
      {error ? (
        <p className="ext-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="ext-rows">
        {catalogs.map((catalog) => (
          <li key={catalog.name} className="ext-row ext-market-catalog">
            <span className="ext-row-head">
              <strong>{catalog.name}</strong>
              <span className="muted">{catalog.entries} listed</span>
            </span>
            <span className="muted">{catalog.source}</span>
            <span className="ext-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => marketplaceRefresh(catalog.name))}
              >
                Refresh
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => marketplaceRemove(catalog.name))}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      <h4>Available extensions</h4>
      {entries.length === 0 ? (
        <p className="muted">
          {catalogs.length === 0
            ? "Add a catalog to browse extensions."
            : "No extensions are listed."}
        </p>
      ) : (
        <ul className="ext-rows">
          {entries.map((entry) => (
            <li
              key={`${entry.marketplace}:${entry.id}`}
              className="ext-row ext-market-entry"
            >
              <span className="ext-row-head">
                <strong>{entry.name}</strong>
                {entry.version ? (
                  <span className="muted">{entry.version}</span>
                ) : null}
                <span className="badge">{entry.marketplace}</span>
              </span>
              <span>{entry.description}</span>
              <span className="muted">{entryStatus(entry)}</span>
              {entry.tags.length > 0 ? (
                <span className="ext-chips">
                  {entry.tags.map((tag) => (
                    <span key={tag} className="badge">
                      {tag}
                    </span>
                  ))}
                </span>
              ) : null}
              <span className="ext-actions">
                <button
                  type="button"
                  disabled={busy || entry.installed?.pinned === true}
                  onClick={() => onInstall(entry.install)}
                >
                  {entry.installed
                    ? entry.installed.update_available
                      ? "Review update"
                      : "Reinstall"
                    : "Review install"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
