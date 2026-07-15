---
title: Installation
description: Two pieces. The Chrome extension and the CLI. One command wires them together.
nav: Installation
order: 1
---

Chrome Relay is two artifacts that meet in the middle:

1. **The extension** runs inside Chrome, holds the CDP session, and executes browser actions.
2. **The CLI** is what your agent invokes. It ships with the native messaging host that the extension connects to.

## 1. Install the extension

From the [Chrome Web Store](https://chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb). Install it once in every browser profile you want your agent to reach.

The primary supported browsers are:

- **Google Chrome**, including several Chrome profiles at the same time.
- **Dia**.
- **Brave**.

The installer also writes native-host manifests for detected Chrome Canary, Chromium, Edge, Vivaldi, Arc, and Opera installations. Those are compatibility targets; manifest detection does not by itself mean they have received the same end-to-end testing as Chrome, Dia, and Brave.

Permissions it asks for, and why:

| Permission | Used for |
|---|---|
| `nativeMessaging` | connecting to the local CLI host. This is the only channel out of the extension, and it goes to your own machine |
| `debugger` | CDP: trusted clicks, snapshots, screenshots, network/console capture |
| `tabs`, `tabGroups` | listing and targeting tabs, workspaces |
| `storage` | ref-map persistence across extension service-worker restarts |

## 2. Install the CLI

Needs [Node.js](https://nodejs.org) 18 or newer — the CLI ships as an npm package and works on macOS, Windows, and Linux.

```sh
pnpm add -g chrome-relay     # or npm i -g chrome-relay
chrome-relay install
```

`install` detects every Chromium-family browser on the machine and registers the native messaging host for each. On Windows it also writes the HKCU registry entries Chrome reads, and drops a `run-host.cmd` wrapper under `%USERPROFILE%\.chrome-relay`.

**Windows note:** if `chrome-relay` isn't recognized right after the global install, restart your terminal so `PATH` picks up the npm global bin (`%APPDATA%\npm`), then re-run `chrome-relay install`.

## 3. Verify

```sh
chrome-relay doctor
chrome-relay --version
chrome-relay profile list
```

Doctor checks the whole chain: wrapper script, per-browser manifests, connected extension instances, local hosts, versions, and upload file access. Multi-browser/profile routing requires CLI and extension 0.8.0 or newer. If `chrome-relay --version` stays below 0.8 after installing the latest package, find the stale executable first (`which -a chrome-relay` on macOS/Linux; `where chrome-relay` on Windows).

`profile list` is the authoritative answer to “which running browsers and profiles can my agent reach right now?” Then:

```sh
chrome-relay tabs
```

If you get your window and tab list as JSON, you're done.

## Multiple browsers and profiles

One CLI serves every supported browser/profile where the extension is installed. Each extension instance has a stable generated ID; Chrome does not expose profile names, so you can attach your own labels:

```sh
chrome-relay profile list
chrome-relay profile label work                       # one instance connected
chrome-relay --profile 3f2a profile label personal    # several: select by ID prefix
chrome-relay --profile work tabs
```

With one connected instance, every command routes there and no flag is needed. With several, an unscoped command returns `profile_ambiguous` as a picker containing each label, browser, ID prefix, and exact `--profile` retry. Chrome Relay never guesses. Snapshot refs are profile-qualified (`@3f2a:e12`), so actions on a ref route themselves after the first snapshot.

## 4. Teach your agent (optional but recommended)

If the CLI is installed, print the version-matched playbook:

```sh
chrome-relay skills get core
```

For agents with a skills directory:

```sh
npx -y skills add kiluazen/kstack@chrome-relay
```

The `-y` auto-confirms npx's "install the `skills` package?" prompt, so a headless agent doesn't hang on a TTY question. This installs the [agent skill](/docs/skill/). It teaches the snapshot/ref loop, which text tool to pick for which editor, the fallback ladder, and the failure modes. Also available raw at [/skill.md](/skill.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `extension_not_connected` | Install the extension, re-run `chrome-relay install`, then restart Chrome |
| `doctor` says no wrapper | Run `chrome-relay install` |
| Worked yesterday, dead today | Chrome may have restarted the native host. Retry once, then toggle the extension off/on |
| `profile_ambiguous` | Pick one of the exact `--profile` choices in the error and rerun the command |
| Browser missing from `profile list` | Install the extension in that exact browser/profile, then rerun `chrome-relay install` |
| `profile` is an unknown command | Your PATH is resolving a pre-0.8 CLI; locate and remove the stale executable |
| `unsupported_tool` on `snapshot` | Extension is older than the CLI. Update the extension from `chrome://extensions` |

## Updating

```sh
chrome-relay update          # updates the CLI and prints what changed, as JSON
chrome-relay release-notes --since 0.5.22   # just read the changelog
```

The changelog is agent-readable on purpose. Your agent can check what changed before relying on a new flag.
