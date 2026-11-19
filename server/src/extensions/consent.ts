import {
  type ExtensionCapability,
  type ExtensionManifest,
  isActionEvent,
} from "../../../shared/extensions";
import { describeMismatch, type ModAnalysis } from "./analyze";
import type { ExtensionRecord } from "./registry";

/** Plain-language risk of each capability, shown before consent. */
export const CAPABILITY_RISKS: Readonly<Record<ExtensionCapability, string>> = {
  ui: "Shows its own panels, badges, menu items and notices.",
  gates: "Can block actions and ask you to approve them.",
  commands: "Adds commands to the palette and shortcuts.",
  "workspace.read": "Reads workspaces, tabs, panes, agents and Git status.",
  "files.read": "Reads files in your checkouts.",
  "files.write": "Changes files in your checkouts.",
  "herdr.read": "Reads anything Herdr reports.",
  "herdr.write":
    "Changes Herdr: opens, closes and rearranges workspaces and panes.",
  "terminal.read": "Reads what terminals show.",
  "terminal.write": "Types into terminals and agents.",
  "agent.sessions": "Reads agent session history and transcripts.",
  notifications: "Sends notifications to your devices.",
  process: "Runs programs on this computer with your permissions.",
  "process.remote": "Runs programs on your SSH hosts with your permissions.",
  network: "Connects to the network hosts listed below.",
  "http.routes": "Receives HTTP requests and serves pages through Roamgate.",
  ranger: "Gives Ranger new tools.",
  secrets: "Reads the secrets you enter in its settings.",
};

export const CONSENT_NOTICE =
  "Extensions run with your user's permissions and are not sandboxed. Mutations made outside Roamgate (in the Herdr TUI, by agents in their terminals, by other Herdr clients) are not gated; extensions only observe them.";

export interface ConsentSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: ExtensionRecord["source"];
  capabilities: Array<{ id: ExtensionCapability; risk: string }>;
  /** Events the mod and its hooks handle; `gates` are the action events among them. */
  events: string[];
  gates: string[];
  /** Exact argv of each command hook, with its event. */
  hooks: Array<{ on: string; command: string[] }>;
  /** Endpoint each url hook POSTs its event to. */
  url_hooks: Array<{ on: string; url: string }>;
  routes: string[];
  network_hosts: string[];
  build: Array<{ command: string[]; platforms?: string[] }>;
  imports: string[];
  calls: string[];
  mismatches: string[];
  unreadable: string[];
  warnings: string[];
  notice: string;
}

export type ConsentRecord = NonNullable<ExtensionRecord["consent"]>;

function hookLabel(hook: { on: string; command: string[] }): string {
  return `${hook.on} ${JSON.stringify(hook.command)}`;
}

export function consentSummary(args: {
  manifest: ExtensionManifest;
  analysis: ModAnalysis;
  source: ExtensionRecord["source"];
  warnings?: string[];
}): ConsentSummary {
  const { manifest, analysis } = args;
  const hooks = manifest.hooks
    .filter((hook) => hook.command)
    .map((hook) => ({ on: hook.on, command: hook.command ?? [] }));
  const events = [
    ...new Set([...analysis.events, ...manifest.hooks.map((hook) => hook.on)]),
  ].sort();
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
    source: args.source,
    capabilities: manifest.capabilities.map((id) => ({
      id,
      risk: CAPABILITY_RISKS[id],
    })),
    events,
    gates: events.filter((event) => isActionEvent(event)),
    hooks,
    url_hooks: manifest.hooks.flatMap((hook) =>
      hook.url ? [{ on: hook.on, url: hook.url }] : [],
    ),
    routes: manifest.routes.map((route) =>
      route.kind === "webhook"
        ? `webhook ${route.name ?? ""}`
        : `proxy ${route.path ?? "/"} -> ${route.upstream ?? ""}`,
    ),
    network_hosts: manifest.network_hosts,
    build: manifest.build.map((step) => ({
      command: step.command,
      ...(step.platforms ? { platforms: step.platforms } : {}),
    })),
    imports: analysis.imports,
    calls: analysis.calls,
    mismatches: analysis.mismatches.map((mismatch) =>
      describeMismatch(manifest.id, mismatch),
    ),
    unreadable: analysis.unreadable,
    warnings: [...(args.warnings ?? []), ...analysis.errors],
    notice: CONSENT_NOTICE,
  };
}

/** What the registry keeps of a consent, to diff the next version against. */
export function consentRecord(
  summary: ConsentSummary,
  at = Date.now(),
): ConsentRecord {
  return {
    capabilities: summary.capabilities.map((entry) => entry.id),
    events: summary.events,
    hooks: [
      ...summary.hooks.map(hookLabel),
      ...summary.url_hooks.map((hook) => `${hook.on} ${hook.url}`),
    ],
    routes: summary.routes,
    imports: summary.imports,
    at,
  };
}

type ConsentCategory = Exclude<keyof ConsentRecord, "at">;
const CATEGORIES: readonly ConsentCategory[] = [
  "capabilities",
  "events",
  "hooks",
  "routes",
  "imports",
];

export type ConsentDiff = Record<
  ConsentCategory,
  { added: string[]; removed: string[] }
>;

/** Added and removed capabilities, events, hooks, routes and imports. */
export function consentDiff(
  previous: ConsentRecord | undefined,
  next: ConsentSummary,
): ConsentDiff {
  const current = consentRecord(next, 0);
  const diff = {} as ConsentDiff;
  for (const category of CATEGORIES) {
    const before = new Set(previous?.[category] ?? []);
    const after = new Set(current[category]);
    diff[category] = {
      added: [...after].filter((item) => !before.has(item)),
      removed: [...before].filter((item) => !after.has(item)),
    };
  }
  return diff;
}

/** True when consent covers less than the new version asks for. */
export function needsNewConsent(diff: ConsentDiff): boolean {
  return CATEGORIES.some((category) => diff[category].added.length > 0);
}

export function diffIsEmpty(diff: ConsentDiff): boolean {
  return CATEGORIES.every(
    (category) =>
      diff[category].added.length === 0 && diff[category].removed.length === 0,
  );
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length ? [`${title}:`, ...lines.map((line) => `  ${line}`)] : [];
}

/** The consent summary as CLI text; with a diff, the changes come first. */
export function formatConsent(
  summary: ConsentSummary,
  diff?: ConsentDiff,
): string {
  const source = summary.source;
  const lines = [
    `${summary.name} (${summary.id}) ${summary.version}`,
    ...(summary.description ? [summary.description] : []),
    `Source: ${source.kind} ${source.location}${source.ref ? ` @ ${source.ref}` : ""}${source.resolved ? ` (${source.resolved})` : ""}`,
  ];
  if (diff) {
    const changes = CATEGORIES.flatMap((category) => [
      ...diff[category].added.map((item) => `+ ${category}: ${item}`),
      ...diff[category].removed.map((item) => `- ${category}: ${item}`),
    ]);
    lines.push(
      ...(changes.length
        ? section("Changes from the consented version", changes)
        : ["No change in capabilities, events, hooks, routes or imports."]),
    );
  }
  lines.push(
    ...section(
      "Capabilities",
      summary.capabilities.map((entry) => `${entry.id}: ${entry.risk}`),
    ),
    ...section("Handles events", summary.events),
    ...section("Gates", summary.gates),
    ...section(
      "Command hooks",
      summary.hooks.map(
        (hook) => `${hook.on}: ${JSON.stringify(hook.command)}`,
      ),
    ),
    ...section(
      "Url hooks (event JSON is POSTed)",
      summary.url_hooks.map((hook) => `${hook.on}: ${hook.url}`),
    ),
    ...section("HTTP routes", summary.routes),
    ...section("Network hosts", summary.network_hosts),
    ...section(
      "Build commands",
      summary.build.map((step) => JSON.stringify(step.command)),
    ),
    ...section("Runtime imports", summary.imports),
    ...section(
      "$ calls",
      summary.calls.map((call) => `$.${call}`),
    ),
    ...section("Capability mismatches", summary.mismatches),
    ...section("Not readable without running it", summary.unreadable),
    ...section("Warnings", summary.warnings),
    "",
    summary.notice,
  );
  return lines.join("\n");
}
