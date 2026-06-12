# Chrome Relay

Your agent drives the Chrome you're signed into — reads pages, clicks buttons, fills forms from any shell. No robot browser, no cookie export, no focus stealing.

```sh
pnpm add -g chrome-relay && chrome-relay install     # plus the Chrome extension
chrome-relay navigate "https://kushalsm.com" --new          # background tab
chrome-relay snapshot --tab 1234 -i                  # actionable elements get @refs
chrome-relay click @e12                              # act — no selectors, no --tab
```

**Docs: [chrome-relay.kushalsm.com/docs](https://chrome-relay.kushalsm.com/docs/)** · [Quickstart](https://chrome-relay.kushalsm.com/docs/quickstart/) · [Why your real Chrome](https://chrome-relay.kushalsm.com/docs/why-your-real-chrome/) · [Command reference](https://chrome-relay.kushalsm.com/docs/commands/) · agent surface: [llms.txt](https://chrome-relay.kushalsm.com/llms.txt) / [skill.md](https://chrome-relay.kushalsm.com/skill.md)

Extension: [Chrome Web Store](https://chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb) · CLI: [npm](https://www.npmjs.com/package/chrome-relay)

## How it works

```
agent (any shell)
  → chrome-relay CLI
  → localhost HTTP (127.0.0.1:12122)
  → native messaging host
  → Chrome extension (service worker)
  → CDP (chrome.debugger)
  → your real tabs
```

Everything is local — no cloud relay, no account, no telemetry. The extension attaches to the *already running* Chrome through native messaging, so there's no `--remote-debugging-port` relaunch and no open debug port. Details: [architecture](https://chrome-relay.kushalsm.com/docs/architecture/).

## Surface

Snapshots with actionable `@refs` (accessibility tree + cursor-interactive sweep, ~14 KB for the HN front page), trusted clicks and typing (`isTrusted: true`, works on React-Aria/Radix), per-tab console + network buffers with HAR export, screenshots of background tabs, screencast, device emulation, named workspaces for multi-agent work, and structured error codes agents branch on. Full list: [commands](https://chrome-relay.kushalsm.com/docs/commands/).

## Workspace

- `apps/extension` — Chrome extension: tool handlers, ref map, snapshot builder, CDP
- `packages/cli` — CLI, native host, localhost bridge, install flow
- `packages/protocol` — shared tool schemas, error codes, snapshot renderer
- `landing` — chrome-relay.kushalsm.com, including the docs pipeline (`docs-src/` → `build-docs.mjs`)
- `skills/chrome-relay` — the agent skill (mirror; canonical in [kstack](https://github.com/kiluazen/kstack))

## Develop

```sh
pnpm install
pnpm build
pnpm -r test                               # protocol + cli + extension unit suites
cd apps/extension && npx playwright test   # e2e against a real Chromium
chrome-relay self-reload                   # reload the extension after a rebuild
```

Load the unpacked extension from `apps/extension/build/chrome-mv3` for development. Store zips: `pnpm store:zip` → `apps/extension/build/`.
