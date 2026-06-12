# Installation

> Two pieces — the Chrome extension and the CLI. One command wires them together.


Chrome Relay is two artifacts that meet in the middle:

1. **The extension** — runs inside Chrome, holds the CDP session, executes every browser action.
2. **The CLI** — what your agent invokes. Ships with the native messaging host that the extension connects to.

## 1. Install the extension

From the [Chrome Web Store](https://chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb). Works in Chrome and Chromium forks — Edge, Brave, Arc, Vivaldi, Opera.

Permissions it asks for, and why:

| Permission | Used for |
|---|---|
| `nativeMessaging` | connecting to the local CLI host — the only channel out of the extension, and it goes to your own machine |
| `debugger` | CDP: trusted clicks, snapshots, screenshots, network/console capture |
| `tabs`, `tabGroups` | listing and targeting tabs, workspaces |
| `storage` | ref-map persistence across extension service-worker restarts |

## 2. Install the CLI

```sh
pnpm add -g chrome-relay     # or npm i -g chrome-relay
chrome-relay install
```

`install` detects every Chromium-family browser on the machine and registers the native messaging host for each (macOS, Linux, and Windows — on Windows it also writes the HKCU registry entries Chrome reads).

## 3. Verify

```sh
chrome-relay doctor
```

Doctor checks the whole chain: wrapper script present, native host starts, extension connects, local bridge reachable. Then:

```sh
chrome-relay tabs
```

If you get your window and tab list as JSON, you're done.

## 4. Teach your agent (optional but recommended)

```sh
npx skills add kiluazen/kstack@chrome-relay
```

This installs the [agent skill](/docs/skill/) — the playbook that tells Claude Code / Codex how to use the commands well (the snapshot→ref loop, which text tool to pick for which editor, the fallback ladder). Also available raw at [/skill.md](/skill.md).

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `extension_not_connected` | Extension not installed, or installed after `chrome-relay install` ran → re-run `chrome-relay install`, then restart Chrome |
| `doctor` says no wrapper | CLI installed but `install` never ran → `chrome-relay install` |
| Worked yesterday, dead today | Chrome updated and restarted the native host → usually self-heals on first command; otherwise toggle the extension off/on |
| Commands hang ~15 s then time out | Another process is holding port 12122 → kill it or reboot the bridge by restarting Chrome |
| `unsupported_tool` on `snapshot` | Extension is older than the CLI → update the extension (Web Store updates roll out on Chrome's schedule; `chrome://extensions` → Update forces it) |

## Updating

```sh
chrome-relay update          # updates the CLI and prints what changed, as JSON
chrome-relay release-notes --since 0.5.22   # just read the changelog
```

The changelog is agent-readable on purpose — your agent can check what changed before relying on a new flag.
