// Reference mod. Slot data and element trees come from `ui.render`; the
// GitHub CLI runs where the checkout lives (over SSH for remote connections).
import type { Dollar, Events, On, ProcessResult, Tone } from "roamgate";

type RenderEvent = Events["ui.render"];

interface Run {
  name: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  url: string;
}

const FIELDS = "name,status,conclusion,headBranch,url";

async function runs(
  $: Dollar,
  event: RenderEvent,
  limit: number,
): Promise<Run[] | null> {
  const context = event.context ?? {};
  const cwd =
    typeof context.checkout_path === "string" ? context.checkout_path : null;
  if (!cwd) return null;
  const branch = await $.config.get("branch");
  const argv = [
    "gh",
    "run",
    "list",
    "--limit",
    String(limit),
    "--json",
    FIELDS,
  ];
  if (typeof branch === "string" && branch) argv.push("--branch", branch);
  const options = { cwd, readOnly: true, timeout: 15_000 };
  let result: ProcessResult;
  try {
    result = await $.process.run(argv, {
      ...options,
      connection: event.connection?.id,
    });
  } catch (error) {
    // `connection` is only for SSH hosts; Roamgate refuses it for local ones.
    if (!String(error).includes("local connection")) throw error;
    result = await $.process.run(argv, options);
  }
  if (result.code !== 0) return null;
  return JSON.parse(result.stdout) as Run[];
}

function tone(run: Run): Tone {
  if (run.status !== "completed") return "warning";
  if (run.conclusion === "success") return "success";
  return run.conclusion === "failure" ? "danger" : "neutral";
}

export function register(on: On) {
  on("ui.render", { slot: "workspace.badge" }, async ($, event) => {
    const [latest] = (await runs($, event, 1)) ?? [];
    if (!latest) return null;
    return {
      text:
        latest.status === "completed"
          ? (latest.conclusion ?? "done")
          : latest.status,
      tone: tone(latest),
      icon: "circle-dot",
      tooltip: `${latest.name} on ${latest.headBranch}`,
    };
  });

  on("ui.render", { slot: "inspector.panel" }, async ($, event) => {
    const list = await runs($, event, 10);
    if (!list)
      return {
        t: "Empty",
        title: "No CI runs",
        body: "Open a GitHub checkout with the gh CLI signed in.",
      };
    return {
      t: "Stack",
      gap: 2,
      children: [
        { t: "Text", text: "Recent runs", weight: "strong" },
        {
          t: "Table",
          columns: ["Workflow", "Branch", "Result"],
          rows: list.map((run) => [
            { t: "Link", href: run.url, label: run.name },
            { t: "Text", text: run.headBranch, mono: true },
            { t: "Badge", text: run.conclusion ?? run.status, tone: tone(run) },
          ]),
        },
        {
          t: "Button",
          id: "refresh",
          label: "Refresh",
          icon: "refresh-cw",
          command: "refresh",
        },
      ],
    };
  });

  on("command.run", { command: "refresh" }, async ($) => {
    await $.ui.invalidate("workspace.badge");
    await $.ui.invalidate("inspector.panel");
    return null;
  });
}
