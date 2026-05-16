# chrome-relay

`chrome-relay` connects your local Chrome browser to coding agents through a local bridge and a Chrome extension.

## Install

```bash
pnpm add -g chrome-relay
chrome-relay install
chrome-relay doctor
```

Then load the Chrome Relay extension in Chrome.

The native host installer allowlists the published Chrome Web Store extension ID:

```text
cpdiapbifblhlcpnmlmfpgfjlacebokb
```

`chrome-relay doctor` prints the supported extension IDs and warns if the native-host manifest is stale.

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

## How it works

`chrome-relay` is a CLI-first browser bridge:

```text
chrome-relay CLI
-> local bridge on your machine
-> Chrome native host
-> Chrome Relay extension
-> Chrome APIs
```

The CLI does not need separate MCP configuration. It talks to the local bridge for you.
