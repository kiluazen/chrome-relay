# chrome-relay

`chrome-relay` connects your running Chromium-family browsers and profiles to coding agents through local native hosts and the Chrome Relay extension.

## Install

```bash
pnpm add -g chrome-relay
chrome-relay install
chrome-relay doctor
```

Then install the Chrome Relay extension in every browser/profile you want reachable. The primary supported targets are Chrome (including multiple profiles), Dia, and Brave. The installer also writes manifests for detected Chrome Canary, Chromium, Edge, Vivaldi, Arc, and Opera installations as compatibility targets.

The native host installer allowlists the published Chrome Web Store extension ID:

```text
cpdiapbifblhlcpnmlmfpgfjlacebokb
```

`chrome-relay doctor` checks every detected browser manifest and registered profile. `chrome-relay profile list` prints the currently reachable browser/profile instances.

## Usage

```bash
chrome-relay tabs
chrome-relay read -i
chrome-relay navigate "https://example.com" --new
chrome-relay navigate --tab <tabId> "https://example.com"
chrome-relay click "<selector>"
chrome-relay fill "<selector>" "value"
chrome-relay keys "Enter"
chrome-relay screenshot --tab <tabId> -o page.png
```

With one connected instance no profile flag is needed. With several, an unscoped command returns `profile_ambiguous` with exact `--profile <label|idprefix>` choices. Run `chrome-relay --profile <choice> tabs`, or use a qualified ref such as `@3f2a:e12`, which routes itself.

## How it works

`chrome-relay` is a CLI-first browser bridge:

```text
chrome-relay CLI
-> verified local instance registry
-> one browser/profile's authenticated localhost host
-> that browser/profile's Chrome Relay extension
-> Chrome APIs
```

The CLI does not need separate MCP configuration. It talks to the local bridge for you.
