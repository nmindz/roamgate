# Third-Party Notices

Roamgate includes or renders assets from third-party projects. Those assets
keep their own licenses and are not relicensed under the project's
GPL-3.0-or-later license.

## Roamgate artwork

The Roamgate bird, wordmark, icons, and social images were supplied by the
project owner. They are not Herdr's official logo. The small application marks
are resized exports of that artwork, displayed on a warm-white background.

## Nerd Fonts

`web/src/assets/herdr-nerd-symbols.woff2` is a glyph-only derivative of
[Nerd Fonts](https://github.com/ryanoasis/nerd-fonts). Nerd Fonts combines
glyph sources under several licenses; the bundled font remains subject to the
upstream licensing terms documented in
[`LICENSES/NERD-FONTS.txt`](./LICENSES/NERD-FONTS.txt) and the upstream
[license audit](https://github.com/ryanoasis/nerd-fonts/blob/master/license-audit.md).

## Lobe Icons

Agent brand icons imported from `@lobehub/icons-static-svg` are provided by
[Lobe Icons](https://github.com/lobehub/lobe-icons), Copyright (c) 2023
LobeHub, under the MIT License. See
[`LICENSES/LOBE-ICONS.txt`](./LICENSES/LOBE-ICONS.txt). The static website
vendors the same Codex and Kimi SVGs as `site/assets/codex.svg` and
`site/assets/kimi.svg` so it does not need a package install or icon CDN.

## Pi

`web/src/assets/pi-logo.svg` is adapted from the
[Pi press kit](https://pi.dev/press-kit), which publishes its assets under the
MIT License. See [`LICENSES/PI.txt`](./LICENSES/PI.txt). The static website
uses a copy at `site/assets/pi.svg`.

When updating these website icons, copy them from the application sources
used by `web/src/components/AgentIcon.tsx`. The deployed site includes their
notices in `site/assets/agent-icons-LICENSE.txt`.

## Bun runtime

Release binaries are built with `bun build --compile` and embed the
[Bun](https://bun.com) runtime, which is MIT licensed. Bun links
JavaScriptCore/WebKit, which is licensed under LGPL-2.0/2.1. See
<https://bun.com/docs/project/license> for the full list of Bun's licenses and
bundled components.

## elkjs

The web client bundles [elkjs](https://github.com/kieler/elkjs) (via
`beautiful-mermaid`) for Mermaid diagram layout. elkjs is licensed under the
Eclipse Public License 2.0; its source is available at
<https://github.com/kieler/elkjs>. See
[`LICENSES/ELKJS-EPL-2.0.txt`](./LICENSES/ELKJS-EPL-2.0.txt).

## Trademarks

Herdr, Pi, Codex, Claude, Gemini, Kimi, Grok, and other product names and logos
are trademarks of their respective owners. Their appearance identifies
compatible tools and does not imply endorsement of Roamgate.

JavaScript dependencies retain the licenses declared by their respective
packages.
