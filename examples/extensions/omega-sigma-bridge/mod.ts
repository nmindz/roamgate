// Reference extension. The "OmegaSigma" action on OMP agents opens the run
// viewer that Roamgate proxies from the local server (see `[[routes]]`): the
// page at /ext/<id>/web/ embeds it in an opaque-origin frame, and shows the
// manifest's start_hint while the server is down.
import type { On } from "roamgate";

const VIEWER = "/ext/roamgate.omega-sigma-bridge/web/";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function register(on: On) {
  // The command's result names the page to open for the selected agent.
  on("command.run", { command: "open" }, (_$, event) => {
    const query = new URLSearchParams();
    const cwd = text(event.cwd) ?? text(event.checkout_path);
    if (cwd) query.set("cwd", cwd);
    query.set("session", text(event.session) ?? "latest");
    return { open: `${VIEWER}?${query}` };
  });
}
