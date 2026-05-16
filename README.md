# Chrome Relay

Chrome Relay exposes your existing browser profile to coding agents through a local bridge and a Chrome extension. The developer CLI is `chrome-relay`.

## What Exists Now

- Minimal Chrome extension with a status popup
- Local native host + local bridge server
- `chrome-relay install` and `chrome-relay doctor`
- Core browser tools only:
  - `get_windows_and_tabs`
  - `chrome_navigate`
  - `chrome_switch_tab`
  - `chrome_close_tabs`
  - `chrome_screenshot`
  - `chrome_read_page`
  - `chrome_click_element`
  - `chrome_fill_or_select`
  - `chrome_keyboard`

## Workspace

- `apps/extension`: Chrome extension runtime and popup
- `packages/cli`: native host, local bridge server, install flow, CLI
- `packages/protocol`: shared tool schemas and bridge message contracts

## Quick Start

1. Install dependencies and build:

```bash
pnpm install
pnpm build
```

2. Register the native host:

```bash
node packages/cli/dist/cli.js install
```

3. Load the unpacked extension from:

```text
apps/extension/build/chrome-mv3
```

4. Run the CLI against your live browser:

```bash
node packages/cli/dist/cli.js tabs
node packages/cli/dist/cli.js read -i
node packages/cli/dist/cli.js screenshot --tab <tabId> -o evidence.png
```

## Store Release

Build the extension zip for Chrome Web Store upload:

```bash
pnpm store:zip
```

The uploadable archive is written under `apps/extension/build/`, for example:

```text
apps/extension/build/chrome-relay-extension-0.2.3-chrome.zip
```

Review the store checklist and permission copy in:

```text
docs/chrome-web-store.md
docs/privacy-policy.md
```

## Current Notes

- The install flow currently targets Chrome on macOS and Linux.
- The Chrome Web Store extension ID is pinned to `cpdiapbifblhlcpnmlmfpgfjlacebokb` so native messaging registration is deterministic.
- The local bridge rejects browser-origin requests. Use the CLI, not arbitrary webpages, to drive it.
- This is intentionally a thin browser-control core, not a workflow builder or embedded chat product.
