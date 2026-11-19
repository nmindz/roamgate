import { useCallback, useEffect, useState } from "react";
import type {
  ExtensionLogLine,
  ExtensionStateEntry,
} from "../../../shared/extensions";
import { ConsentView } from "./ConsentView";
import { SettingsForm } from "./SettingsForm";
import { useStoreSelector } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import {
  type ConsentCheck,
  type ExtensionConfig,
  extConfigGet,
  extConsent,
  extConsentAccept,
  extLogs,
  extManage,
} from "./rpc";

export const STATUS_TEXT: Record<ExtensionStateEntry["status"], string> = {
  active: "Active",
  idle: "Idle",
  disabled: "Disabled",
  failed: "Disabled after failures",
  invalid: "Invalid",
  incompatible: "Incompatible",
  safe_mode: "Not loaded (safe mode)",
};

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="ext-section">
      <h4>{title}</h4>
      <ul className="ext-plain-list">
        {items.map((item) => (
          <li key={item}>
            <code>{item}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ExtensionPage({
  entry,
  ids,
  onBack,
}: {
  entry: ExtensionStateEntry;
  ids: string[];
  onBack: () => void;
}) {
  const [config, setConfig] = useState<ExtensionConfig | null>(null);
  const [consent, setConsent] = useState<ConsentCheck | null>(null);
  const [logs, setLogs] = useState<ExtensionLogLine[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ConsentCheck | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [keepData, setKeepData] = useState(false);
  const index = ids.indexOf(entry.id);
  const client = useConnectionClient();
  const connectionLabel = useStoreSelector(
    (state) =>
      state.connections.find((item) => item.id === client.connectionId)
        ?.label ?? "this connection",
  );

  const loadLogs = useCallback(
    () => extLogs(entry.id).then(setLogs, (e) => setError(messageOf(e))),
    [entry.id],
  );
  useEffect(() => {
    let current = true;
    extConfigGet(entry.id, client.connectionId).then(
      (result) => current && setConfig(result),
      (e) => current && setError(messageOf(e)),
    );
    // Invalid or incompatible extensions have no consent summary to show.
    extConsent(entry.id).then(
      (result) => current && setConsent(result),
      () => {},
    );
    void loadLogs();
    return () => {
      current = false;
    };
  }, [entry.id, client.connectionId, loadLogs]);

  const run = async (work: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await work();
      done?.();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const move = (delta: number) => {
    const next = [...ids];
    next.splice(index + delta, 0, ...next.splice(index, 1));
    void run(() => extManage({ op: "order", ids: next }));
  };
  const toggle = () =>
    void run(async () => {
      if (entry.enabled) return extManage({ op: "disable", id: entry.id });
      const check = await extConsent(entry.id);
      setConsent(check);
      if (check.needs_consent) return setReview(check);
      return extManage({ op: "enable", id: entry.id });
    });

  if (review)
    return (
      <ConsentView
        summary={review.summary}
        diff={review.diff}
        confirmLabel="Enable"
        busy={busy}
        onCancel={() => setReview(null)}
        onConfirm={() =>
          void run(
            async () => {
              await extConsentAccept(entry.id);
              await extManage({ op: "enable", id: entry.id });
            },
            () => setReview(null),
          )
        }
      />
    );

  const summary = consent?.summary;
  const unusable =
    entry.status === "invalid" || entry.status === "incompatible";
  return (
    <div className="ext-page">
      <button type="button" className="ext-back" onClick={onBack}>
        Back to extensions
      </button>
      <div className="ext-page-head">
        <div>
          <h3>{entry.name}</h3>
          <span className="muted">
            {entry.id} {entry.version}
            {summary
              ? ` from ${summary.source.kind}: ${summary.source.location}`
              : ""}
          </span>
        </div>
        <span className={`badge ext-status ext-status-${entry.status}`}>
          {STATUS_TEXT[entry.status]}
        </span>
      </div>
      {entry.reason ? <p className="ext-warning">{entry.reason}</p> : null}
      {entry.last_error ? (
        <p className="ext-error" role="alert">
          Last error: {entry.last_error.message}
        </p>
      ) : null}
      {error ? (
        <p className="ext-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="ext-actions">
        <button type="button" onClick={toggle} disabled={busy || unusable}>
          {entry.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={() => move(-1)}
          disabled={busy || index <= 0}
          aria-label={`Move ${entry.name} earlier`}
        >
          Move up
        </button>
        <button
          type="button"
          onClick={() => move(1)}
          disabled={busy || index < 0 || index >= ids.length - 1}
          aria-label={`Move ${entry.name} later`}
        >
          Move down
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => setConfirmUninstall(true)}
          disabled={busy}
        >
          Uninstall
        </button>
      </div>
      {confirmUninstall ? (
        <div
          className="ext-confirm"
          role="alertdialog"
          aria-label="Confirm uninstall"
        >
          <p>Uninstall {entry.name}?</p>
          <label>
            <input
              type="checkbox"
              checked={keepData}
              onChange={(event) => setKeepData(event.target.checked)}
            />
            Keep its data
          </label>
          <div className="ext-actions">
            <button type="button" onClick={() => setConfirmUninstall(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    extManage({
                      op: "uninstall",
                      id: entry.id,
                      keep_data: keepData,
                    }),
                  onBack,
                )
              }
            >
              Uninstall
            </button>
          </div>
        </div>
      ) : null}
      <div className="ext-section">
        <h4>Capabilities</h4>
        <div className="ext-chips">
          {entry.capabilities.length === 0 ? (
            <span className="muted">None</span>
          ) : null}
          {entry.capabilities.map((capability) => (
            <span key={capability} className="badge ext-chip">
              {capability}
            </span>
          ))}
        </div>
      </div>
      <div className="ext-section">
        <h4>Settings</h4>
        {config ? (
          <SettingsForm
            key={client.connectionId}
            ext={entry.id}
            schema={config.schema}
            values={config.values}
            connectionId={client.connectionId}
            connectionLabel={connectionLabel}
          />
        ) : (
          <p className="muted">Loading...</p>
        )}
      </div>
      <List
        title="Commands"
        items={entry.contributions.commands.map((c) => `${c.id}: ${c.title}`)}
      />
      <List
        title="Slots"
        items={entry.contributions.slots.map((s) => `${s.slot}/${s.id}`)}
      />
      <List
        title="Keybindings"
        items={entry.contributions.keybindings.map(
          (k) => `${k.key} runs ${k.command}`,
        )}
      />
      <List title="Handled events" items={summary?.events ?? []} />
      <List
        title="Command hooks"
        items={(summary?.hooks ?? []).map(
          (hook) => `${hook.on}: ${hook.command.join(" ")}`,
        )}
      />
      <List title="HTTP routes" items={summary?.routes ?? []} />
      <div className="ext-section">
        <div className="ext-section-head">
          <h4>Logs</h4>
          <button type="button" onClick={() => void loadLogs()}>
            Refresh logs
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="muted">No log lines yet.</p>
        ) : (
          <pre className="ext-logs" aria-label="Extension logs">
            {logs
              .map(
                (line) =>
                  `${new Date(line.at).toLocaleTimeString()} ${line.level} ${line.line}`,
              )
              .join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
