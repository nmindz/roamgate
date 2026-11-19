import type { ExtensionCapability } from "../../../shared/extensions";
import {
  CONSENT_CATEGORIES,
  type ConsentDiff,
  type ConsentSummary,
} from "./rpc";

export const CAPABILITY_TEXT: Record<ExtensionCapability, string> = {
  ui: "Show panels, badges and menu entries",
  gates: "Approve, ask about or deny actions before they run",
  commands: "Add commands to the palette",
  "workspace.read": "Read workspace, tab and pane names",
  "files.read": "Read files in your workspaces",
  "files.write": "Create, move and delete files",
  "herdr.read": "Read Herdr state",
  "herdr.write": "Change Herdr workspaces, tabs and panes",
  "terminal.read": "Read terminal output",
  "terminal.write": "Type into terminals",
  "agent.sessions": "Read agent sessions",
  notifications: "Send notifications",
  process: "Run programs on this machine",
  "process.remote": "Run programs on connected machines",
  network: "Call the network hosts it lists",
  "http.routes": "Accept web requests and proxy a local web app",
  ranger: "Add tools to Ranger",
  secrets: "Store and read secrets",
};

const RISKS = ["high", "medium", "low"] as const;
type Risk = (typeof RISKS)[number];

function riskOf(risk: string): Risk {
  return (RISKS as readonly string[]).includes(risk) ? (risk as Risk) : "high";
}

function sourceLabel(source: ConsentSummary["source"]) {
  return `${source.kind}: ${source.location}${source.ref ? ` @ ${source.ref}` : ""}`;
}

function Group({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="ext-consent-group">
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <code>{item}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Diff({ diff, from }: { diff: ConsentDiff; from?: string }) {
  const lines = (kind: "added" | "removed") =>
    CONSENT_CATEGORIES.flatMap((category) =>
      diff[category][kind].map((item) => `${category}: ${item}`),
    );
  const added = lines("added");
  const removed = lines("removed");
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div className="ext-consent-diff">
      <h4>Changes since {from ?? "the consented version"}</h4>
      <Group title="Added" items={added} />
      <Group title="Removed" items={removed} />
    </div>
  );
}

export function ConsentView({
  summary,
  diff,
  installedVersion,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  summary: ConsentSummary;
  diff?: ConsentDiff;
  installedVersion?: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="ext-consent" aria-label={`Review ${summary.name}`}>
      <h3>
        {summary.name} {summary.version}
      </h3>
      {summary.description ? (
        <p className="muted">{summary.description}</p>
      ) : null}
      <p className="ext-consent-warning" role="note">
        {summary.notice ||
          "Extensions run with your user permissions and are not sandboxed."}
      </p>
      <dl className="ext-consent-source">
        <dt>Source</dt>
        <dd>{sourceLabel(summary.source)}</dd>
        {summary.source.resolved ? (
          <>
            <dt>Resolved</dt>
            <dd>
              <code>{summary.source.resolved}</code>
            </dd>
          </>
        ) : null}
      </dl>
      {diff ? <Diff diff={diff} from={installedVersion} /> : null}
      {RISKS.map((risk) => {
        const items = summary.capabilities.filter(
          (capability) => riskOf(capability.risk) === risk,
        );
        if (items.length === 0) return null;
        return (
          <div key={risk} className={`ext-consent-risk ext-risk-${risk}`}>
            <h4>{risk[0].toUpperCase() + risk.slice(1)} risk capabilities</h4>
            <ul>
              {items.map(({ id }) => (
                <li key={id}>
                  <code>{id}</code>
                  <span>{CAPABILITY_TEXT[id] ?? "Unknown capability"}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <Group title="Handled events" items={summary.events} />
      <Group title="Can allow, rewrite or deny" items={summary.gates} />
      <Group
        title="Command hooks"
        items={summary.hooks.map(
          (hook) => `${hook.on}: ${hook.command.join(" ")}`,
        )}
      />
      <Group title="HTTP routes" items={summary.routes} />
      <Group title="Network hosts" items={summary.network_hosts} />
      <Group
        title="Build commands"
        items={summary.build.map((step) => step.command.join(" "))}
      />
      <Group title="Runtime imports" items={summary.imports} />
      <Group title="Capability mismatches" items={summary.mismatches} />
      <Group title="Could not be read statically" items={summary.unreadable} />
      {summary.warnings.map((warning) => (
        <p key={warning} className="ext-warning" role="alert">
          {warning}
        </p>
      ))}
      <div className="ext-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Working..." : confirmLabel}
        </button>
      </div>
    </section>
  );
}
