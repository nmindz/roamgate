# Security Policy

## Supported Versions

Security fixes cover the latest release.

## Reporting a Vulnerability

**Do not open a public issue.** Use a private repository security advisory with
versions, reproduction steps, and impact. If unavailable, use the maintainer's
GitHub-profile contact address.

## Trust Model

**Anyone who can use the UI has the Roamgate user's full authority:**
terminals, repository hooks, session data, and file uploads/deletions. Roamgate
is single-user administration, not a sandbox or multi-user permission system.
- The default bind is `127.0.0.1`. **Login is required, including on
  loopback.** The only exception is `NODE_ENV=development` bound to
  `127.0.0.1`, `localhost`, or `::1` (what `bun run dev:server` uses). Never
  forward a development listener.
- Set `ROAMGATE_PASSWORD` to 8-1024 characters; use 15 or more for anything
  reachable beyond a trusted private network (shorter passwords print a
  warning). Without a password, Roamgate generates a persistent 256-bit token
  and prints the file that holds it. Keep token URLs private.
- Session cookies last 30 days and are signed by a separate random secret in
  the data directory (`session-secret.json`). Changing the password, token, or
  PIN rotates that secret on the next start and signs out every browser. Stop
  all listeners of an instance before changing credentials. Upgrading from
  builds that signed cookies with the password/token requires one new login;
  those legacy cookies are deliberately rejected. See
  [signing state](docs/DEPLOYMENT.md#run-as-a-user-service).
- Login request bodies are limited to 16 KiB (`413` beyond that).
- Login is rate-limited per source IP: 20 attempts per minute, and five
  consecutive failures trigger a five-minute cooldown (HTTP `429` with
  `Retry-After`). Limits are per process and reset on restart. Forwarded IP
  headers are not trusted, so clients behind one proxy share its limit.

### Optional PIN login

`ROAMGATE_PIN` (6-12 digits) adds a convenience login for listeners reachable
**only** through a trusted VPN or private network. It is much weaker than a
password or token, yet grants the same full access, and startup prints a
warning. The password/token remains available via **Use password or token
instead**.

PIN attempts have their own per-IP limits, and ten consecutive failures from
any source disable PIN login for one hour. Limits are per process, so multiple
listeners multiply the guessing budget. If attacked, remove `ROAMGATE_PIN` and
restart **every** listener of the instance; this signs out all browsers,
including password sessions.

### Access and session safety

**Do not expose Roamgate directly to the public internet.** For remote access:
- Prefer `ROAMGATE_PASSWORD` over `--password`, which is visible in process
  arguments.
- Use [native HTTPS](docs/DEPLOYMENT.md#native-https), an HTTPS proxy, or a
  trusted VPN, and restrict who can reach the listener.
- Treat worktree hooks and [extensions](#extensions) as executable code.

The bridge does not check `Origin` or `Host`; any authenticated request has full
authority, so secure the access path itself.

**Menu > Log out** removes this browser's cookie only. It does not revoke copied
cookies or log out other browsers. If a credential or cookie leaks, change the
password (or run `roamgate auth rotate` for a generated token), or run
`roamgate auth revoke-sessions` to sign out every browser. These commands only
restart the managed service: also restart any other listener of the instance
(for example a foreground `roamgate`), and handle each separate
`ROAMGATE_SETTINGS_PATH` instance on its own.

Updates trust the configured HTTPS release origin and its checksums. Checksums
detect corruption, not publisher identity; treat custom mirrors as trusted code.

Legacy `HERDR_GUI_*` variables alias `ROAMGATE_*` (new names win, even when
empty). Protect migrated token copies and backups; see
[migration](./docs/DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui).

Web Push subscriptions are tied to devices, not logins: changing the password or
logging out does not revoke them. Disable notifications or remove subscriptions
separately. Notifications may show agent names on lock screens. See
[Web Push](docs/DEPLOYMENT.md#web-push-notifications).

### Extensions

**Extensions run unsandboxed with the Roamgate user's permissions.** A mod is
a Bun program in its own process; command hooks and build steps are ordinary
programs. Installing one is running its author's code. See the
[authoring guide](docs/EXTENSIONS.md#trust-model).
- **Capabilities are declarations, not a sandbox.** They are enforced where an
  extension calls Roamgate's `$` API: a call needing an undeclared capability
  fails, `$.http.fetch` reaches only `network_hosts`, and extensions can
  never answer approvals or manage extensions. Nothing stops a mod's own code
  from reading files or starting processes directly.
- **Consent.** Installing and updating show the capabilities, handled events
  and gates, exact command-hook argv, HTTP routes, network hosts, build
  commands, direct `node:`/`bun:` imports, and `$` calls read from the source
  without running it. An update that adds any of these asks again. Git
  installs are pinned to the resolved commit; archives must match their
  SHA-256. Marketplace catalogs never install or update anything themselves.
- **Environment.** Extension processes inherit only an allowlist (`PATH`,
  `HOME`, locale, temp and Windows system variables). Roamgate's password,
  PIN, token, session secret, TLS key, VAPID key, and `NODE_OPTIONS` /
  `BUN_OPTIONS` never reach them, and a mod cannot pass them on.
- **Safe mode.** `roamgate --safe-mode`, `ROAMGATE_SAFE_MODE=1`, or the
  runtime switch loads no extension, command hook, route, or slot, and denies
  pending approvals. Use it to recover from a misbehaving extension.
- **Approvals** hold a gated action until a person answers in any logged-in
  browser (or via a Web Push notification that opens one). The first answer
  wins; unanswered requests resolve at their timeout (deny by default); a
  request whose connection was replaced is denied. Every decision is recorded
  in `receipts.sqlite`, and a request whose receipt cannot be written is
  denied. Gates cover actions taken through Roamgate only: changes made in
  the Herdr TUI, by agents in their terminals, or by other Herdr clients are
  not gated.
- **Frames** run in `sandbox allow-scripts` iframes with an opaque origin, no
  cookies, and a CSP of `default-src 'none'` plus only the sources the
  manifest declares. They reach the mod only through the host page's
  `postMessage` bridge, which ignores messages from other windows.
- **Proxied web apps** load in `sandbox allow-scripts allow-forms` iframes
  under a sandbox CSP (`connect-src 'self'`, `frame-ancestors 'self'`).
  Requests carry a 15-minute HMAC capability instead of the session;
  `Authorization` and `Cookie` are not forwarded, `Set-Cookie` is not
  returned, and the referrer policy keeps the capability out of `Referer`.
  Logging out revokes every capability. Upstreams must be loopback `http`.
- **Webhooks** (`POST /api/ext/<id>/hooks/<name>`) bypass login and are
  authorized by a per-extension bearer token compared in constant time. No
  token exists until someone requests it; rotating it invalidates the old one
  at once. Bodies are limited to 1 MiB. On non-loopback binds, anyone who
  reaches the listener can try a token: keep webhooks behind HTTPS and the
  same access controls as the rest of Roamgate.
- **Secrets** from `secret` settings are stored in the extension's
  `secrets.json` (mode `0600`), are shown to browsers only as set or unset,
  and reach the mod only when it declares `secrets`. Webhook tokens and
  `receipts.sqlite` are also `0600`. Anyone who can read the data directory
  can read them.
