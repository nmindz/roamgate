// Reference extension. The "Local web app" action on an agent opens a web app
// that Roamgate proxies from this computer (see `[[routes]]`): the page at
// /ext/<id>/web/ embeds it in an opaque-origin frame, and shows the
// manifest's start_hint while nothing listens on the upstream.
import type { On } from "roamgate";

const PAGE = "/ext/roamgate.local-web-app/web/";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function register(on: On) {
  // Answering `{ open }` with this extension's own page opens it in Roamgate.
  on("command.run", { command: "open" }, (_$, event) => {
    const query = new URLSearchParams();
    const cwd = text(event.cwd) ?? text(event.checkout_path);
    if (cwd) query.set("cwd", cwd);
    return { open: `${PAGE}?${query}` };
  });
}
