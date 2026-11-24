# Extensions

How to write, test, and ship a Roamgate extension. See
[Architecture](./ARCHITECTURE.md#extensions) for how the bridge runs them,
[Deployment](./DEPLOYMENT.md#extensions) for data paths and flags, and
[Security](../SECURITY.md#extensions) for the trust model.

Extension API version: **1.0**. The wire types live in
`shared/extensions.ts`; `roamgate ext types` writes the SDK declarations.

## Trust model

**Extensions run unsandboxed, with the permissions of the user who runs
Roamgate.** A mod is a Bun program in its own child process; command hooks
and build steps are ordinary programs. Nothing stops a mod from importing
`node:fs` or `Bun.spawn` and doing anything that user can do.

Capabilities are declarations, checked at the `$` boundary: a `$` call that
needs a capability the manifest does not declare fails with a capability
error, and installing shows every capability, event, command hook, route,
network host, build command, and direct `node:`/`bun:` import before asking
for consent. They describe what the extension says it does; they are not a
sandbox. Install only extensions you would run as a script.

Mutations made outside Roamgate (in the Herdr TUI, by agents in their own
terminals, by other Herdr clients) are not gated; extensions only observe
them.

## Layout

An extension is a directory with `roamgate-extension.toml` at its root:

```text
acme-ci/
  roamgate-extension.toml
  src/mod.ts            # optional: the mod
  hooks/guard.ts        # optional: command hooks
  frames/chart.html     # optional: frame assets
  themes/dusk.json      # optional: manifest-only contributions
```

An extension needs no mod: themes, keybindings, link patterns, composer
commands, static slot entries, and command hooks all work from the manifest
alone.

Quick start:

```bash
roamgate ext types my-ext       # roamgate.d.ts and a tsconfig.json
roamgate ext validate my-ext    # manifest, mod analysis, consent summary
roamgate ext link my-ext        # run it in place; edits reload it
roamgate ext test my-ext        # bun test against the fake host
roamgate ext logs my.ext --follow
```

Reference extensions live in `examples/extensions/`: `hello` (command,
toast, status bar item, settings), `guard-rails` (deny, ask, fail-closed
gate, command hook), `ci-badges` (workspace badge, Inspector panel,
`$.process.run` over SSH), and `local-web-app` (context menu command whose
`{ open }` answer shows a proxied local web app).

## Manifest

```toml
id = "acme.ci-badges"
name = "CI badges"
version = "1.2.0"
api = "^1.0"
min_roamgate_version = "0.9.0"
description = "Shows GitHub Actions status."
author = { name = "Acme", url = "https://acme.dev", email = "dev@acme.dev" }
homepage = "https://acme.dev/ci-badges"
repository = "https://github.com/acme/ci-badges"
license = "MIT"
platforms = ["linux", "macos", "windows"]
capabilities = ["ui", "commands", "workspace.read", "process.remote"]
network_hosts = ["api.github.com"]
mod = "./src/mod.ts"
activation = ["slot:workspace.badge", "command:refresh"]
experimental = false
start_hint = "acme-ci serve --port 4747"
```

Unknown top-level keys warn; unknown keys inside any table or table entry are
errors. Paths start with `./`, and must resolve (after following links)
inside the extension directory.

| Key                                 | Required | Meaning                                                                                                       |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `id`                                | yes      | 1-64 letters, digits, `.`, `_` or `-`. Unique among installed extensions; it namespaces everything below.     |
| `name`                              | yes      | Display name.                                                                                                 |
| `version`                           | yes      | SemVer.                                                                                                       |
| `api`                               | yes      | Accepted API versions: `^1.0`, `~1.0`, `>=1.0`, or `1.0`. A range this Roamgate misses makes it incompatible. |
| `min_roamgate_version`              | no       | SemVer; older Roamgate marks the extension incompatible.                                                      |
| `description`                       | no       | Shown in the Extensions tab and the consent summary.                                                          |
| `author`                            | no       | Table with `name`, `url`, `email`.                                                                            |
| `homepage`, `repository`, `license` | no       | Strings shown on the extension's page.                                                                        |
| `platforms`                         | no       | Any of `linux`, `macos`, `windows`. Other hosts mark it incompatible. Omitted means every platform.           |
| `capabilities`                      | no       | Closed set; see [capabilities](#capabilities).                                                                |
| `network_hosts`                     | no       | Hosts `$.http.fetch` may reach: `host`, `host:port`, or `*.domain` (subdomains only).                         |
| `mod`                               | no       | The mod module (`./src/mod.ts`). Without it, `activation` is ignored.                                         |
| `activation`                        | no       | When the mod starts; see [activation](#activation). Defaults to `["startup"]` when a mod is set.              |
| `experimental`                      | no       | `true` opts in to experimental events such as `rpc.call`.                                                     |
| `start_hint`                        | no       | Command shown on the "is not running" page when a proxied upstream is down.                                   |

### Settings: `[config.<key>]`

```toml
[config.token]
type = "secret"
title = "GitHub token"
description = "A fine-grained token with Actions: read."
required = true
scope = "global"
```

Keys use letters, digits, `_` and `-`.

| Field         | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `type`        | `string`, `number`, `boolean`, `select`, `secret`, `directory`, or `file`. |
| `title`       | Label (required).                                                          |
| `description` | Help text.                                                                 |
| `default`     | String, number, or boolean. Secrets cannot have one.                       |
| `required`    | Clearing a required setting is refused.                                    |
| `options`     | For `select`: strings or `{ value, label }` tables.                        |
| `min`, `max`  | For `number`.                                                              |
| `scope`       | `global` (default) or `connection`: one value per connection profile.      |

Text values are at most 4096 characters. The Extensions tab renders the form;
saving a value sends the mod `config.change` with the changed keys. Non-secret
values live in the GUI settings file under `extensions.<id>`; secrets live in
the extension's `secrets.json` (see [secrets](#secrets)).

### Build steps: `[[build]]`

```toml
[[build]]
platforms = ["linux", "macos"]
command = ["roamgate:bun", "install", "--frozen-lockfile"]
timeout = 300
```

Run once per install or update, in the new version directory, before the
registry points at it. `command` is an argv array (no shell); `roamgate:bun`
as `argv[0]` runs Roamgate's embedded Bun. `timeout` is 1-3600 seconds
(default 300; never more than 30 minutes). Output goes to `logs/build.log`. A
failed build discards the new version and leaves the previous one active.
Linked directories never build.

### Commands and keybindings

```toml
[[commands]]
id = "rerun"
title = "Re-run CI"
icon = "refresh-cw"
detail = "Re-runs the latest failed workflow"
keywords = ["ci"]
danger = false
when = { remote = false }

[[keybindings]]
command = "rerun"
key = "mod+shift+r"
when = {}
```

Commands appear in the command menu (and in slots that name them) and run the
mod's `command.run` handler. Ids use letters, digits, `_` and `-`; Roamgate
namespaces them as `<ext-id>:<command-id>`. `when` is a
[matcher](#matchers) over the current context (`connection_id`,
`workspace_id`, `tab_id`, `pane_id`, `agent`, and so on).

A command may answer `{ open: "/ext/<id>/web/<path>?<query>" }` to show its
own [proxied page](#proxy) over the workspace (full screen on phones, with a
button to move it to a new tab). Only the extension's own `/ext/<id>/web/`
prefix opens; other paths, other origins, `..` escapes and the `_/<cap>/`
frame path are ignored, and the rest of the answer is returned unchanged.
Slot context has no agent session; a mod that needs it calls
`$.agent.session(pane_id)`.

A keybinding must name a declared command. `mod` is `Cmd` on macOS and `Ctrl`
elsewhere; the key must be one the web app accepts as a global shortcut, so
users can rebind it under **Keyboard shortcuts**. Conflicts are worked out
per platform: built-in shortcuts always win, then extensions in their
configured order. A binding that loses on a platform does not apply there,
and `ext.state` lists it in that keybinding's `conflicts` (platform, key,
and the winner: a built-in shortcut id or `ext:<id>:<command>`), which the
Extensions tab and shortcut settings show. A user binding for the same keys
overrides all of them.

### Slots: `[[slots]]`

```toml
[[slots]]
slot = "context-menu.agent"
id = "open"
title = "Local web app"
command = "open"
when = { agent = "omp" }
```

| Field                                                          | Meaning                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `slot`                                                         | One of the [slots](#slots).                                           |
| `id`                                                           | Entry id; `slot` + `id` must be unique.                               |
| `title`, `detail`, `text`, `icon`, `tone`, `tooltip`, `danger` | Static slot data.                                                     |
| `command`                                                      | A declared command run when the entry is chosen.                      |
| `when`                                                         | Matcher over the slot context; hidden entries never activate the mod. |

Static fields describe the entry without a mod. When the mod answers
`ui.render` for the entry, its answer replaces them.

### Command hooks: `[[hooks]]`

```toml
[[hooks]]
on = "pane.close"
matcher = { agent = "claude" }
command = ["roamgate:bun", "./hooks/guard.ts"]
timeout = 30
on_failure = "continue"
platforms = ["linux", "macos"]
```

`on` is any event name. `command` is an argv array; relative arguments must
resolve inside the extension. Instead of `command`, `url` names an endpoint
the event is POSTed to (exactly one of the two). `timeout` is 1-600 seconds
(default 30). `on_failure` is `continue` (default) or `block`. See
[command hooks](#command-hooks) and [url hooks](#url-hooks).

### Routes: `[[routes]]`

```toml
[[routes]]
kind = "webhook"
name = "permission"
timeout = 120

[[routes]]
kind = "proxy"
upstream = "http://127.0.0.1:4747"
path = "/"
```

Both kinds need the `http.routes` capability. A webhook needs `name` (letters,
digits, `_`, `-`) and may set `timeout` (1-600 seconds). A proxy needs an
`http://` upstream on `127.0.0.1`, `::1`, or `localhost`; `path` is the
prefix it serves under (default `/`). See [routes](#routes).

### Frames: `[[frames]]`

```toml
[[frames]]
id = "chart"
entry = "./frames/chart.html"
height = 240
csp = { connect = ["https://api.example.com"], resource = ["https://cdn.example.com"], frame = [] }
```

`entry` must exist. `csp` lists host or scheme sources only (no keywords,
quotes, separators, or spaces). See [frames](#frames).

### Manifest-only contributions

```toml
[[themes]]
kind = "terminal"           # or "accent"
file = "./themes/dusk.json"
id = "dusk"
name = "Dusk"

[[link_patterns]]
pattern = "PROJ-\\d+"
url = "https://tracker.example.com/browse/{0}"

[[composer_commands]]
name = "/standup"
description = "Draft a standup update"
arguments = "[team]"
agents = ["claude"]
expand = "Summarise what changed since yesterday."

[[previewers]]
extensions = [".csv"]
mime_types = ["text/csv"]
frame = "chart"
```

- **Themes:** `file` is a JSON object of at most 256 KiB, read at validation
  time and shipped inline in `ext.state`, so browsers never fetch extension
  files. Terminal themes appear with the custom terminal themes; accent
  palettes override Roamgate's documented colour tokens.
- **Link patterns:** a regular expression over terminal text (it must not
  match empty text) and a URL template. The URL must be `http(s)` and start
  with a literal host, not a placeholder. Placeholders are `{N}`: `{0}` is the
  whole match and `{1}` and up are capture groups; `N` cannot exceed the
  pattern's group count.
- **Composer commands:** `name` is `/` plus letters, digits, `_` or `-`;
  choosing one inserts `expand`. `agents` limits it to those agents.
- **Previewers:** name a declared frame and match files by `extensions`
  and/or `mime_types` (at least one). The frame gets the file through
  `roamgate/event`, never a Roamgate-authorized URL.

## Capabilities

| Capability       | What it allows                                                                         |
| ---------------- | -------------------------------------------------------------------------------------- |
| `ui`             | `$.ui.toast`, `$.ui.invalidate`, `$.events.emit`.                                      |
| `gates`          | `$.ui.ask`. Declare it when the mod gates actions; the consent screen lists the gates. |
| `commands`       | Adds commands to the palette and shortcuts.                                            |
| `workspace.read` | `$.roamgate.*`.                                                                        |
| `files.read`     | `$.files.read` in workspace checkouts.                                                 |
| `files.write`    | `$.files.write` in workspace checkouts; gated as `file.write`.                         |
| `herdr.read`     | `$.herdr.call` with read methods.                                                      |
| `herdr.write`    | `$.herdr.call` with any other method; gated like the UI.                               |
| `terminal.read`  | `$.terminal.screen`.                                                                   |
| `terminal.write` | `$.terminal.send`, `$.terminal.keys`; gated as `terminal.submit` / `terminal.keys`.    |
| `agent.sessions` | `$.agent.session`, `$.agent.history`.                                                  |
| `notifications`  | `$.notify.push`.                                                                       |
| `process`        | `$.process.run` on this computer.                                                      |
| `process.remote` | `$.process.run` with `connection` on an SSH host.                                      |
| `network`        | `$.http.fetch` to `network_hosts`.                                                     |
| `http.routes`    | `[[routes]]`: webhooks and the proxy.                                                  |
| `ranger`         | Offers [Ranger tools](#ranger-tools).                                                  |
| `secrets`        | Secret setting values in `init` config, `$.config.all`, and `$.config.get`.            |

`roamgate ext validate` reads the mod's `$.ns.method(...)` calls without
running it and reports calls whose capability is missing as errors, using the
same capability table as the runtime.

## Activation

The mod starts on the first matching trigger:

| Trigger        | Starts the mod when                                                                 |
| -------------- | ----------------------------------------------------------------------------------- |
| `startup`      | Roamgate starts (or the extension is enabled). Kept running.                        |
| `event:<name>` | That event fires.                                                                   |
| `command:<id>` | One of its commands runs.                                                           |
| `slot:<slot>`  | A browser renders that slot. Without `[[slots]]` for it, the entry id is `default`. |

An event waits for activation up to its handler budget, and `init` must
finish within 10 seconds. A render starts a stopped mod only under
`slot:<slot>`; otherwise the slot shows the static fields until the mod runs.
A render that outlasts its budget while the mod starts keeps the static
entry and is not recorded as a failure. Mods without `startup` stop after 10 minutes idle.
Each running mod is its own Bun process of roughly 18 MiB resident memory
(measured idle on macOS arm64 with `scripts/bench-extensions-memory.ts`), so
prefer `event:`, `command:` or `slot:` activation over `startup`.
A crashed `startup` mod restarts after 1, 2, 5, 15, then 60 seconds; other
mods start again on their next trigger once the backoff passed. Five handler
failures within 10 minutes disable the extension (status **failed**) until
someone enables it again.

Editing a linked directory reloads the extension after 150 ms of quiet;
`$.store` survives, and browsers render its slots again.

## Writing a mod

```ts
import type { On } from "roamgate";

export function register(on: On) {
  on("command.run", { command: "say-hi" }, async ($) => {
    const greeting = String(await $.config.get("greeting"));
    const count = Number((await $.store.get("greetings")) ?? 0) + 1;
    await $.store.set("greetings", count);
    await $.ui.toast({ kind: "success", message: `${greeting}! (#${count})` });
    await $.ui.invalidate("statusbar.item");
    return { greetings: count };
  });

  on("ui.render", { slot: "statusbar.item" }, async ($) => {
    const count = Number((await $.store.get("greetings")) ?? 0);
    return { text: `${count} greetings`, command: "say-hi" };
  });
}
```

The mod exports `register(on, $)`, a default function, or a default object
with `register`. `register` may be async and may call `on` again later.

`on(event, [matcher], handler, [options])` subscribes a handler.
`handler($, event, next)` gets the `$` API, the frozen event, and `next`:

- Return nothing, or `return next()`, to pass the event on unchanged.
- `return next({ ...event, title: "..." })` passes it on rewritten. Only the
  event's [rewritable fields](#events) change; other changes are dropped and
  logged.
- Return any other value to answer: an action event's [Gate](#gates), a
  `ui.render` element tree, a command's result, and so on. The first answer
  stops the chain.
- Throwing is a handler failure. `options.onFailure: "block"` makes a failing
  gate deny (and a failing `agent.attention` or `notify.send` handler
  suppress it); the default `continue` treats it as no opinion.

Handlers run in extension order (Extensions tab, or `roamgate ext order`):
the first extension is the outermost. An extension's own actions (`$` calls)
never reach its own handlers, only other extensions'.

### Matchers

A matcher maps event fields (dotted paths such as `viewer.mobile` reach into
objects) to a value, an array of accepted values, or a regular expression
(`{ $regex, flags }` in the manifest, a `RegExp` in a mod). An empty matcher
matches everything. Matching runs on the bridge, so unmatched events never
reach the mod.

### Budgets

| Event                              | Own-time budget |
| ---------------------------------- | --------------- |
| default                            | 5000 ms         |
| `ui.render`                        | 250 ms          |
| `terminal.submit`, `terminal.keys` | 2000 ms         |

Time the bridge spends serving the handler's `$` calls, including an ask
waiting for a person, does not count, up to a hard ceiling of 10 minutes per
call. A handler over budget is cancelled and counted as a failure; a child
that ignores three cancellations in a row (one second each) is killed.

### Logging

`$.log.debug|info|warn|error(message, fields)` and `console.*` write the
extension log; anything the mod prints to stdout goes there too. The log
keeps the last 1000 lines in memory and `data/<id>/logs/extension.log` on
disk (rotated at 1 MiB), and is redacted like the service log. Read it in the
extension's page or with `roamgate ext logs <id> [--follow]`.

## Events

Every event has `name` and `at`, and, when they apply, `origin` (`browser`,
`ranger`, `task`, or `extension:<id>`), `connection: { id, generation }`,
`workspace_id`, `tab_id`, `pane_id`, `checkout_path`, `agent`, and
`viewer: { id, mobile }`.

### Observed and answerable events

| Event                  | Extra fields                                       | Rewritable      | Answer                    |
| ---------------------- | -------------------------------------------------- | --------------- | ------------------------- |
| `extension.activate`   | `ext`                                              |                 |                           |
| `extension.deactivate` | `ext`                                              |                 |                           |
| `connection.ready`     | once per runtime generation                        |                 |                           |
| `connection.lost`      | `state` (`replaced`, or the runtime's state)       |                 |                           |
| `viewer.attach`        | a browser connected                                |                 |                           |
| `viewer.detach`        | a browser disconnected                             |                 |                           |
| `herdr.event`          | `event`, `data` (Herdr's own event)                |                 |                           |
| `agent.status`         | `from`, `to`: `working`, `blocked`, `done`, `idle` |                 |                           |
| `agent.attention`      | `kind`, `title`, `body`                            | `title`, `body` | `{ suppress: true }`      |
| `workspace.step`       | `captured`                                         |                 |                           |
| `notify.send`          | `title`, `body`, `target`                          | `title`, `body` | `{ suppress: true }`      |
| `command.run`          | `command`, `args`, plus the caller's context       |                 | the command's result      |
| `ui.render`            | `slot`, `entry_id`, `context`, `viewer`            |                 | element tree or slot data |
| `ui.action`            | `slot`, `entry_id`, `element_id`, `value`          |                 | any                       |
| `config.change`        | `keys`                                             |                 |                           |
| `ranger.tools`         |                                                    |                 | tool descriptors          |
| `tool.<name>`          | `input`                                            |                 | the tool's output         |
| `webhook`              | `route`, `body`, `query`                           |                 | the JSON response body    |
| `frame.call`           | `frame`, `method`, `params`                        |                 | the call's result         |
| `rpc.call`             | `method`, `params` (experimental)                  | `params`        | a result or a Gate        |

`agent.status` fires once per transition; the first status seen for a pane
only seeds it. `command.run`, `ui.render`, `ui.action`, `frame.call`,
`webhook`, `ranger.tools`, and `tool.<name>` go only to the extension they
belong to. `rpc.call` sees every browser RPC except terminal streaming,
`bridge.ping`, and `ext.*`, and needs `experimental = true`.

### Action events

Action events are raised at one choke point per mutation family, so the
browser, Ranger, scheduled tasks, and extensions pass the same gates. The
answer is a [Gate](#gates).

| Event              | Extra fields                                        | Rewritable     | Raised by                                                                                  |
| ------------------ | --------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `terminal.submit`  | `text`, `mode` (`text` or `input`)                  | `text`         | `pane.send_text`, `pane.send_input`, the composer, Ranger `send_prompt`, `$.terminal.send` |
| `terminal.keys`    | `keys`                                              |                | `pane.send_keys`, `$.terminal.keys`                                                        |
| `pane.close`       |                                                     |                | `pane.close`, Ranger `close_pane` / `close_agent`                                          |
| `tab.close`        |                                                     |                | `tab.close`                                                                                |
| `workspace.close`  |                                                     |                | `workspace.close`, Ranger `close_workspace`                                                |
| `pane.split`       | `direction`, `pane_id`                              | `cwd`          | `pane.split`, Ranger `split_pane`                                                          |
| `tab.create`       | `label`, `cwd`                                      | `label`, `cwd` | `tab.create`, Ranger `create_tab`                                                          |
| `workspace.create` | `label`, `cwd`                                      | `label`, `cwd` | `workspace.create`, Ranger `create_workspace`                                              |
| `agent.start`      | `agent`, `label`, `cwd`                             | `label`, `cwd` | Ranger `start_agent`                                                                       |
| `worktree.create`  | `branch`, `path`                                    |                | `worktree.create`, Ranger `create_worktree`                                                |
| `worktree.remove`  | `path`, `force`                                     |                | `worktree.remove`                                                                          |
| `file.write`       | `op` (`upload`, `mkdir`, `move`, `delete`), `paths` |                | `file.mkdir`, `file.move`, file and terminal uploads, deletes                              |
| `git.mutate`       | `op`, `message`                                     | `message`      | `git.pull`, `git.file_action`, `git.repo_action`                                           |
| `settings.change`  | `keys`                                              |                | worktree, auto-rename, auto-sync, terminal transport, and UI settings updates              |
| `update.install`   | `from_version`, `version`                           |                | installing a Roamgate update                                                               |
| `extension.tool`   | `ext`, `tool`, `input`                              |                | a confirmed mutating [Ranger tool](#ranger-tools)                                          |

Rewritten text is limited per field: `text` 65,536 characters, `title` and
`label` 200, `body` 2000, `cwd` 4096, `message` 10,000. A rewrite over any
limit is dropped whole and the original goes on.

Extension management (`ext.*`), terminal streaming and resizing, focus and
layout moves, and reads raise no action event and cannot be gated.

## Gates

```ts
type Gate =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | {
      decision: "ask";
      title: string;
      body?: string;
      detail?: string;
      risk?: "low" | "medium" | "high";
      timeout_ms?: number;
      on_timeout?: "deny" | "allow";
    };
```

Decisions combine across extensions and command hooks as deny > ask > allow;
the first deny stops the chain. A denied action fails with
`Denied by extension <id>: <reason>`. Anything that is not a recognizable
Gate counts as a handler failure, never as allow.

```ts
on("pane.close", async ($, event) => {
  const agents = await $.roamgate.agents(event.connection?.id);
  const busy = findWorking(agents, event.pane_id);
  return busy
    ? { decision: "deny", reason: `${busy.agent} is mid-turn` }
    : { decision: "allow" };
});
```

### Approvals and receipts

An `ask` holds the action until a person decides. Every open browser shows
it; when none is open, Roamgate sends a [Web Push](./DEPLOYMENT.md#web-push-notifications)
notification that opens it. The first answer from any device wins; later
answers learn it was already decided. A gated RPC answers the browser with an
interim `{ id, pending: { approval_id } }` so the page stops its timer.

- `timeout_ms` defaults to 10 minutes (at least 1 second, at most 24 hours);
  `on_timeout` defaults to `deny`.
- Disabling the extension, turning on safe mode, shutting down, or replacing
  the action's connection denies its pending asks. Approving an ask whose
  connection was replaced while it waited denies it.
- Text is clipped: `title` 200 characters, `body` 2000, `detail` 8000.

Every decision leaves one receipt in `receipts.sqlite` (extension, event,
title, decision, cause, answering device, origin, connection, workspace,
pane, times), kept for 30 days and at most 10,000 rows. If the receipt cannot
be written, the action is denied; if the receipt database cannot be opened at
all, every ask is denied. Read them in the extension's page or with
`roamgate ext receipts [id]`.

A mod can ask a person directly with `$.ui.ask` (receipt event `ui.ask`).
Extensions can never answer approvals or manage extensions.

## The `$` API

`$` methods are async calls to the bridge, except `$.state`, `$.clock`, and
`$.log`, which run in the mod's process.

| Call                                                          | Capability                   | Notes                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.all()`                                                | none                         | Every setting; secrets as `{ set: boolean }` unless `secrets`.                                                                                                                                                                                     |
| `config.get(key)`                                             | none (`secrets` for secrets) | One setting, or `null`. Connection-scoped settings use the event's connection.                                                                                                                                                                     |
| `store.get/set/delete/keys`                                   | none                         | JSON values, kept across restarts and updates; 16 MiB total, keys up to 512 characters.                                                                                                                                                            |
| `state`                                                       | none                         | An in-memory `Map`, lost when the mod stops.                                                                                                                                                                                                       |
| `clock.now/setTimeout/clearTimeout/setInterval/clearInterval` | none                         | Timers cleared when the mod stops.                                                                                                                                                                                                                 |
| `log.debug/info/warn/error(message, fields)`                  | none                         | The extension log.                                                                                                                                                                                                                                 |
| `roamgate.connections()`                                      | `workspace.read`             | Connection profiles.                                                                                                                                                                                                                               |
| `roamgate.workspaces([connection])`                           | `workspace.read`             | Herdr `workspace.list`.                                                                                                                                                                                                                            |
| `roamgate.tabs([params], [connection])`                       | `workspace.read`             | Herdr `tab.list`.                                                                                                                                                                                                                                  |
| `roamgate.panes([params], [connection])`                      | `workspace.read`             | Herdr `pane.list`.                                                                                                                                                                                                                                 |
| `roamgate.agents([connection])`                               | `workspace.read`             | Herdr `agent.list`.                                                                                                                                                                                                                                |
| `herdr.call(connection, method, [params])`                    | `herdr.read` / `herdr.write` | Read methods (`ping`, `*.list`, `*.get`, `*.read`, `*.status`, `*.info`, `*.schema`, `*.wait_for_output`) need `herdr.read`; others need `herdr.write` and raise their action event. Event subscriptions and plugin install/uninstall are refused. |
| `terminal.send(pane, text)`                                   | `terminal.write`             | Raises `terminal.submit`.                                                                                                                                                                                                                          |
| `terminal.keys(pane, keys)`                                   | `terminal.write`             | Raises `terminal.keys`.                                                                                                                                                                                                                            |
| `terminal.screen(pane, [{ source, lines }])`                  | `terminal.read`              | Defaults: `source: "recent"`, `lines: 200`.                                                                                                                                                                                                        |
| `agent.session(pane)`                                         | `agent.sessions`             | The pane's agent session summary.                                                                                                                                                                                                                  |
| `agent.history(pane, [options])`                              | `agent.sessions`             | The agent's history.                                                                                                                                                                                                                               |
| `notify.push({ title, body, target })`                        | `notifications`              | Raises `notify.send` (other extensions may rewrite or suppress it), then sends Web Push. Returns `{ suppressed }`.                                                                                                                                 |
| `ui.toast({ kind, message, detail, command })`                | `ui`                         | `kind`: `info`, `success`, `warning`, `error`. Message 500, detail 2000 characters.                                                                                                                                                                |
| `ui.invalidate([slot])`                                       | `ui`                         | Browsers render the slot (or all of this extension's slots) again; at most one push per 100 ms per slot.                                                                                                                                           |
| `ui.ask(ask)`                                                 | `gates`                      | Waits for a person. Returns `{ approved, reason? }`.                                                                                                                                                                                               |
| `events.emit(name, [data], [{ frame }])`                      | `ui`                         | Sends `roamgate/event` to this extension's frames (one frame, or all). Data up to 256 KiB.                                                                                                                                                         |
| `process.run(argv, [options])`                                | `process` / `process.remote` | See below.                                                                                                                                                                                                                                         |
| `http.fetch(url, [init])`                                     | `network`                    | See below.                                                                                                                                                                                                                                         |
| `files.read(path, [options])`                                 | `files.read`                 | See below.                                                                                                                                                                                                                                         |
| `files.write(path, content, [options])`                       | `files.write`                | Raises `file.write` with `op: "upload"`. See below.                                                                                                                                                                                                |

`pane` is a pane id on the event's connection, or `{ pane_id, connection }`.

**Connections.** A call made from a handler defaults to the event's
connection and is pinned to the generation the event saw: if the connection
was replaced in between, the call fails with `connection changed` instead of
acting on the new runtime. Without an event connection, calls use the default
connection.

**`$.process.run(argv, options)`** runs an argv array, never a shell.
Options: `cwd` (absolute; the extension directory by default), `env`, `stdin`
(string), `timeout` (ms, default 30 s, at most 10 min), `connection` (run
over SSH on that connection; needs `process.remote`, refused for local
connections and Windows hosts), and `readOnly` (with `connection`: the
command only reads, so a broken SSH master may rerun it once). Output is cut
at 4 MiB per stream. Returns `{ code, stdout, stderr, truncated? }`. The
child environment is the [allowlist](#environment) plus `env`; Roamgate
credential names are refused.

**`$.http.fetch(url, init)`** reaches `http`/`https` URLs whose host is in
`network_hosts`, checked again on each redirect (at most 5). `init`: `method`,
`headers`, `body` (string), `timeout` (ms, default 30 s). Response bodies are
limited to 4 MiB. Returns `{ status, ok, url, headers, body }`.

**`$.files.read(path, options)`** and **`$.files.write(path, content,
options)`** work on a workspace's checkout. `path` is relative to the
checkout; absolute paths, `..`, and symlinks that resolve outside the checkout
are refused, locally and over SSH, with the same checks as the Files view.
The checkout is the event's workspace (its `checkout_path`); outside a
workspace event, or for another workspace, pass `workspace_id` (and
`connection` for another connection). Options: `workspace_id`, `connection`,
and `encoding` (`"utf8"` or `"base64"`). Reads return `{ content, encoding,
size }`; without `encoding`, UTF-8 text without NUL bytes comes back as
`utf8` and anything else as `base64`. Reads are limited to 5 MiB, the largest
file the Files view previews whole. Writes take a string (`utf8` by default)
and create or replace a regular file in an existing directory, like an
upload; they never replace a directory or a symlink. A write raises
`file.write` (`op: "upload"`, `paths: [path]`) first, so gates and approvals
apply, and is limited to `ROAMGATE_UPLOAD_MAX_BYTES` (100 MiB by default)
within the 16 MiB message limit. Returns `{ ok: true, size }`. Windows SSH
hosts are refused.

### Errors

`$` calls reject with JSON-RPC errors:

| Code     | Meaning                                                          |
| -------- | ---------------------------------------------------------------- |
| `-32010` | The capability is not declared.                                  |
| `-32011` | The connection changed since the event.                          |
| `-32012` | Timeout.                                                         |
| `-32013` | Refused by Roamgate's guard (host, method, or credential rules). |
| `-32601` | No such `$` method.                                              |
| `-32602` | Invalid arguments.                                               |

### Environment

Mods, command hooks, build steps, and `$.process.run` children inherit only
`PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`,
`USER`, `LOGNAME`, `SHELL`, and the Windows system variables (`SystemRoot`,
`windir`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PATHEXT`, `COMSPEC`),
plus `ROAMGATE_EXTENSION_ID`, `ROAMGATE_EXTENSION_ROOT`, and
`ROAMGATE_EXTENSION_DATA`. Roamgate's password, PIN, token, session secret,
TLS key, VAPID key, and `NODE_OPTIONS`/`BUN_OPTIONS` never cross over.

## Elements and slots

### Slots

| Slot                                                                                          | Answer                                                                                          |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `command`, `menu.item`, `topbar.item`, `pane.toolbar`                                         | `{ title, detail?, icon?, command, danger?, disabled_reason? }`                                 |
| `workspace.badge`, `agent.badge`, `tab.badge`                                                 | `{ text?, icon?, tone, tooltip, command? }`                                                     |
| `context-menu.workspace`, `context-menu.agent`, `context-menu.tab`                            | `{ groups: [{ label, items: [{ key, label, detail?, danger?, disabled_reason?, command }] }] }` |
| `statusbar.item`                                                                              | `{ text, tone?, icon?, tooltip?, command? }`                                                    |
| `composer.command`                                                                            | `{ name, description, arguments?, expand? }`                                                    |
| `toast`                                                                                       | `{ kind, message, detail?, command? }`                                                          |
| `sidebar.section`, `inspector.panel`, `workspace.surface`, `pane.overlay`, `settings.section` | an element tree                                                                                 |

`ui.render` events carry `slot`, `entry_id`, the slot `context` (its fields
are also on the event, with the render's connection), and `viewer:
{ mobile, theme, accent, width }`. Answer `null` to show nothing. A failed
render shows an error in place of that entry only.

### Elements

```ts
type El =
  | { t: "Stack" | "Row"; id?; gap?: 0 | 1 | 2 | 3; children: El[] }
  | { t: "Text"; text; tone?; weight?: "normal" | "strong"; mono? }
  | { t: "Markdown"; md }
  | { t: "Code"; code; lang? }
  | { t: "Badge"; text; tone? }
  | { t: "Icon"; name }
  | { t: "Button"; id; label; icon?; tone?; command?; disabled? }
  | { t: "Link"; href; label }
  | { t: "Input" | "TextArea"; id; value; placeholder? }
  | { t: "Select"; id; value; options: { value; label }[] }
  | { t: "Toggle"; id; value: boolean; label }
  | { t: "Progress"; value? } // 0..1; omitted is indeterminate
  | { t: "Spinner" }
  | { t: "List"; items: El[] }
  | { t: "Table"; columns: string[]; rows: El[][] }
  | { t: "KeyValue"; items: { k; v: El }[] }
  | { t: "Divider" }
  | { t: "Image"; src; alt }
  | { t: "Empty"; title; body? }
  | { t: "Frame"; frame; height? };
// tone: "neutral" | "info" | "success" | "warning" | "danger"
```

- Limits: depth 16, 2000 nodes, 256 KiB serialized. Unknown element types
  fail the entry; unknown props are dropped.
- `Markdown` renders no raw HTML and no remote images. `Link` opens `http(s)`
  only. `Image.src` is inline PNG, JPEG, GIF, or WebP data, or a path under
  `/ext/<id>/`.
- A `Button` with `command` runs that command. Buttons and inputs without one
  send `ui.action` with the element's `id` and `value`; answer with a result
  and call `$.ui.invalidate` to show new state.

## Frames

A frame is an extension HTML page in a sandboxed iframe, for UI the element
vocabulary cannot express. Use it with a `Frame` element or a previewer.

Assets are served from `GET /ext/<id>/frame/<path>`, session cookie required:
the entry file itself, or files in an entry's directory, after following
links; anything else is `404`. Every asset carries:

```text
sandbox allow-scripts; default-src 'none';
script-src 'self' 'unsafe-inline' <resource>; style-src 'self' 'unsafe-inline' <resource>;
img-src 'self' data: <resource>; font-src 'self' <resource>; media-src 'self' <resource>;
connect-src <connect>; frame-src <frame>; base-uri 'none'; form-action 'none'
```

`connect-src` and `frame-src` appear only when the frame declares sources;
an asset shared by several frames gets the union. The sandbox gives the frame
an opaque origin: it has no cookies, cannot call Roamgate's API, and holds no
credentials.

### Bridge

Frames talk to the host page with JSON-RPC 2.0 over `postMessage`, shaped
like MCP Apps:

| Direction    | Message                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| frame > host | `ui/initialize` -> `{ hostCapabilities, hostContext: { theme, accent, styles: { variables }, mobile, size, safeAreaInsets } }` |
| frame > host | `ui/notifications/initialized` (nothing else is honoured before it)                                                            |
| host > frame | `ui/notifications/host-context-changed { hostContext }`                                                                        |
| frame > host | `ui/notifications/size-changed { height }`                                                                                     |
| frame > host | `roamgate/call { method, params }` -> the mod's `frame.call` answer                                                            |
| frame > host | `ui/open-link { url }` (`http(s)` only)                                                                                        |
| host > frame | `roamgate/event { name, data }`, from `$.events.emit` or the previewed file                                                    |
| host > frame | `ui/resource-teardown`                                                                                                         |

The host drops messages that do not come from the frame's own window.
`styles.variables` carries Roamgate's colour tokens (`--bg`, `--panel`,
`--text`, `--accent`, and so on) so frames can match the theme.

```ts
on("frame.call", { frame: "chart", method: "series" }, async ($, event) => {
  return await $.store.get("series");
});
```

## Command hooks

A command hook runs a program for an event, alongside the mod chain, with no
mod needed. Hooks of one event run in parallel; each starts in its own
process group, in the extension directory, and is killed with its children on
timeout.

- **stdin:** the event as JSON.
- **Environment:** the [allowlist](#environment), plus `ROAMGATE_EVENT`,
  `ROAMGATE_CONNECTION_ID`, `ROAMGATE_WORKSPACE_ID`, `ROAMGATE_PANE_ID`, and
  `ROAMGATE_CHECKOUT_PATH` when the event has them.
- **`roamgate:bun`** as `argv[0]` runs the script in `argv[1]` (inside the
  extension) with Roamgate's embedded Bun.
- **Exit 0** with no output: no opinion. Optional stdout JSON
  `{ decision?, reason?, title?, rewrite?, message? }`: a Gate (an `ask`
  without `title` uses `reason`), a rewrite validated like a handler's, and a
  message for the extension log.
- **Exit 2** denies, with stderr as the reason.
- **Any other exit,** a timeout, or more than 1 MiB on either stream is a
  failure handled by `on_failure`.

Decisions count only for action events. A hook does not run for actions its
own extension's mod made.

```ts
// hooks/audit.ts: record closes, never block.
const event = JSON.parse(await Bun.stdin.text());
const dir = process.env.ROAMGATE_EXTENSION_DATA;
if (dir) appendFileSync(join(dir, "closes.log"), `${event.pane_id}\n`);
```

### Url hooks

```toml
[[hooks]]
on = "pane.close"
url = "http://127.0.0.1:7070/roamgate"
on_failure = "block"
```

A url hook POSTs the event JSON (`Content-Type: application/json`) to `url`,
in parallel with command hooks and the mod chain; it needs no mod. Decisions
count and combine as for command hooks.

- **Destinations:** `http` or `https` on a loopback host (`127.0.0.1`,
  `[::1]`, `localhost`) or a host in `network_hosts`; validation rejects any
  other, and so does every request. The URL may not carry credentials.
- **Requests** follow no redirects and send no cookies or credentials.
- **A 2xx answer** with an empty body is no opinion. Otherwise the body is the
  same JSON object a command hook prints: `{ decision?, reason?, title?,
  rewrite?, message? }`.
- **Any other status** (redirects included), invalid JSON, a timeout, or more
  than 1 MiB of body is a failure handled by `on_failure`.

## Routes

### Webhooks

`POST /api/ext/<id>/hooks/<name>` with `Authorization: Bearer <token>` and a
JSON body of at most 1 MiB runs the mod's `webhook` handler (match
`{ route: "<name>" }`); its answer is the JSON response. The request is held
open until the answer, including any `$.ui.ask`, up to the route's `timeout`
(default 120 s, at most 600 s): then `504`.

Each extension has one token, stored in its data directory (`0600`) and
created the first time it is requested (the `ext.manage` RPC op
`webhook_token`, which also returns the hooks' URL base); until then the
extension accepts no webhook. `rotate: true` replaces it at once.
Responses: `401` bad token, `404` unknown route, `413` body too large, `400`
not JSON, `502` handler error.

```ts
on("webhook", { route: "permission" }, async ($, event) => {
  const { approved } = await $.ui.ask({
    title: "Allow the deploy?",
    risk: "high",
  });
  return { allow: approved };
});
```

### Proxy

A proxy route shows a local web app inside Roamgate without exposing its
port. `GET /ext/<id>/web/<path>` (session cookie) serves a host page that
embeds `/ext/<id>/web/_/<cap>/<path>` in an `allow-scripts allow-forms`
sandboxed iframe. `<cap>` is an HMAC capability over the extension, route,
and expiry, valid for 15 minutes; the host page renews it through
`POST /api/ext/<id>/web-cap` two minutes before expiry. Logging out revokes
every capability.

Under `/_/<cap>/` every method, Server-Sent Events, and WebSockets reach the
loopback upstream. `Authorization`, `Cookie`, and hop-by-hop headers are not
forwarded; `Set-Cookie` is not returned; upstream redirects are mapped back
under the capability. Responses get `Referrer-Policy: no-referrer`,
`Access-Control-Allow-Origin: null` (the frame's origin is opaque, so its
module scripts, `fetch` and `EventSource` are CORS requests), and:

```text
sandbox allow-scripts allow-forms; default-src 'self' data: blob:;
script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'
```

When nothing listens on the upstream, the page says the app is not running
and shows `start_hint`.

## Secrets

Declare secrets as `type = "secret"` settings. The Extensions tab writes
them to `data/<id>/secrets.json` (mode `0600`), never to the GUI settings
file, and reads them back only as `{ set: true }`. The mod receives secret
values (in `init` config, `$.config.all`, `$.config.get`) only when the
manifest declares `secrets`; otherwise `$.config.get` of a secret fails with
a capability error. Secrets are never written to logs by Roamgate; do not log
them yourself.

## Ranger tools

With the `ranger` capability, a mod can give [Ranger](../FEATURES.md#ranger)
tools. Ranger sends `ranger.tools` once per extension version; answer with up
to 32 descriptors:

```ts
on("ranger.tools", () => [
  {
    name: "ci_status",
    description: "Latest CI run for a branch.",
    input_schema: {
      type: "object",
      properties: { branch: { type: "string" } },
      required: ["branch"],
    },
  },
  {
    name: "ci_rerun",
    description: "Re-run the latest failed workflow.",
    input_schema: { type: "object", properties: {} },
    mutating: true,
  },
]);

on("tool.ci_status", async ($, event) => {
  const { branch } = event.input as { branch: string };
  return `success on ${branch}`;
});
```

- `name` is 1-32 letters, digits, `_` or `-`; `description` is at most 2000
  characters; `input_schema` is a JSON object schema of at most 16 KiB.
  Invalid descriptors are dropped. Ranger sees the tool as
  `ext_<id>__<name>`.
- Calls arrive as `tool.<name>` with `input` (checked for required keys) and
  `origin` `ranger` or `task`. The answer is the tool's output: text, or JSON
  that is serialized. Ranger receives at most 64 KiB, marked as untrusted
  data from the extension.
- A tool with `mutating: true` (or `replay: "unsafe"`) never runs during a
  turn. Ranger proposes an **extension tool** action for a workspace; it runs
  after the user confirms (or at once in high-permission mode), raises the
  `extension.tool` gate with `ext`, `tool`, and `input`, and runs once without
  retries. A tool that changed between proposal and confirmation is refused.

## Testing

`roamgate ext test <dir> [-- <bun test arguments>]` validates the extension,
then runs `bun test` in its directory with a fake host importable as
`roamgate:testing`:

```ts
import { afterEach, expect, test } from "bun:test";
import { createFakeHost, type FakeHost } from "roamgate:testing";

let host: FakeHost | undefined;
afterEach(() => host?.close());

test("refuses to close a working agent", async () => {
  host = await createFakeHost({
    dir: import.meta.dir,
    stubs: {
      "roamgate.agents": { agents: [{ pane_id: "p1", status: "working" }] },
    },
  });
  expect(await host.gate({ name: "pane.close", pane_id: "p1" })).toMatchObject({
    decision: "deny",
  });
});
```

The fake host runs the mod through the real runtime in-process and enforces
capabilities and matchers as Roamgate does.

| Option / member                                                                                     | Meaning                                                                                               |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `dir`, `config`, `store`, `connection`                                                              | Extension directory, setting values (secrets too), initial store, event connection (`null` for none). |
| `stubs` / `stub(call, value)`                                                                       | Answers for `ns.method` calls (`herdr`, `roamgate`, ...); a function gets the arguments.              |
| `asks` / `answerAsks(answer)`                                                                       | `"approve"`, `"deny"` (default), or a function of the ask.                                            |
| `emit(event)`                                                                                       | Runs the chain; returns `{ event, answer, gate, errors }`.                                            |
| `gate(event)`                                                                                       | The combined Gate of an action event.                                                                 |
| `render(slot, [context], [entryId])`                                                                | The mod's `ui.render` answer.                                                                         |
| `command(id, [args])`                                                                               | Runs a declared command.                                                                              |
| `calls`, `toasts`, `notifications`, `invalidations`, `processes`, `asks`, `logs`, `store`, `config` | What the mod did.                                                                                     |

## Types and stability

`roamgate ext types [dir]` writes `roamgate.d.ts`, declaring the modules
`roamgate` (manifest, events, `$`, elements) and `roamgate:testing` (the fake
host), for the running Roamgate's API, plus a `tsconfig.json` when the
directory has none; `--output FILE` writes the declarations alone. Mods use
type-only imports, which Bun erases:

```ts
import type { On } from "roamgate";
```

`API_STABILITY` in `shared/extensions.ts` marks every event and `$` method
as stable, experimental, or deprecated. Stable APIs do not break within a
major API version. Experimental ones (today only `rpc.call`) need
`experimental = true`; without it, validation fails (`ext validate` exits 2)
and the extension is invalid. They may change in any minor release. A
deprecated API keeps working for at least one minor release before removal;
`roamgate ext validate` warns where it is used, and the extension log gets
one warning line per deprecated API per run.

## The `roamgate ext` CLI

Run on the machine (and as the user) that runs the service. Changes apply to
a running service without a restart; otherwise when it starts. Exit codes: 0
ok, 1 failure, 2 usage or validation errors.

| Command                                                     | Purpose                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ext install <source> [--ref REF] [--sha256 HEX] [--yes]`   | Install from `owner/repo[/subdir]` on GitHub, a git URL, or an HTTPS archive URL with `--sha256`. Shows the consent summary first. |
| `ext link <dir>` / `ext unlink <id>`                        | Run a local directory in place; edits reload it. No build steps run.                                                               |
| `ext uninstall <id> [--keep-data]`                          | Remove it and, unless kept, its data directory.                                                                                    |
| `ext enable <id>` / `ext disable <id>`                      | Enabling also clears an automatic disable.                                                                                         |
| `ext list [--json]` / `ext info <id> [--json]`              | Installed extensions, status, source; one extension's consent summary and changes since consent.                                   |
| `ext update [id...] [--ref REF] [--yes]`                    | Check installed extensions for new versions, show what each update adds or removes, and apply.                                     |
| `ext validate <dir> [--json]`                               | Manifest, mod analysis, capability mismatches, deprecations, and the consent summary.                                              |
| `ext logs <id> [--lines N] [--follow]`                      | Build and runtime logs.                                                                                                            |
| `ext order <id...>`                                         | Move these first, in this order.                                                                                                   |
| `ext receipts [id] [--limit N] [--json]`                    | Approval receipts, newest first.                                                                                                   |
| `ext test <dir> [-- <bun test arguments>]`                  | See [testing](#testing).                                                                                                           |
| `ext types [dir]` / `ext types --output FILE`               | See [types](#types-and-stability).                                                                                                 |
| `ext marketplace add <source>` / `remove <name>`            | Add or remove a catalog.                                                                                                           |
| `ext marketplace list [--json]` / `refresh [name] [--json]` | Show catalogs with install commands; re-read them.                                                                                 |

Installing and updating need consent: interactive runs ask, non-interactive
runs need `--yes`. Git sources are cloned and pinned to the resolved commit;
archives must match `--sha256`. Each version is installed in its own
directory, so a running version finishes its in-flight handlers before the new
one takes over. An update that adds capabilities, events, hooks, routes, or
imports asks again.

Strict validation (`"extensions_strict_validation": true` in the GUI
settings file) refuses mods whose handlers or `$` calls static analysis
cannot read, such as computed event names or `$[name]`.

## Marketplaces

A marketplace is a `roamgate-marketplace.json` catalog in a GitHub repository
(`owner/repo[/subdir]`), a git repository, at an HTTPS URL, or in a local
file:

```json
{
  "name": "acme",
  "description": "Acme's Roamgate extensions",
  "extensions": [
    {
      "id": "acme.ci-badges",
      "name": "CI badges",
      "description": "GitHub Actions status in the sidebar",
      "version": "1.2.0",
      "source": "acme/roamgate-extensions/ci-badges",
      "ref": "0123456789abcdef0123456789abcdef01234567",
      "tags": ["ci", "github"]
    }
  ]
}
```

`name` is 1-64 letters, digits, `.`, `_` or `-`. Each entry needs a unique
`id` and a `source` as `ext install` accepts it; git sources pin with `ref`
(a full 40-hex commit SHA), archives with `sha256`. Catalogs only list
extensions: adding or refreshing one never installs, updates, or enables
anything.

- `roamgate ext marketplace list` prints each entry with a pinned install
  command, such as `roamgate ext install <source> --ref <sha>`.
- The Extensions tab browses catalogs through `ext.marketplace.browse`. Each
  entry carries `install` params for `ext.install.preview`, so installing
  shows the normal consent screen, and says whether it is installed, pinned,
  or has an update.
- `ext update` moves an extension installed from a catalog to the catalog's
  current pin (`--ref` overrides it).
- Removing a marketplace leaves its installed extensions in place.

## Safe mode

`roamgate --safe-mode`, `ROAMGATE_SAFE_MODE=1`, or the runtime switch
(`ext.manage` op `safe_mode`) turns every extension off: no mod, command
hook, route, or slot runs, pending asks are denied, and a banner says
extensions are off. The runtime switch is saved in `registry.json` and
persists across restarts; **Turn off safe mode** in the Extensions tab clears
it. The flag and variable apply to that run only. An unreadable
`registry.json` also keeps extensions off until it is fixed.
