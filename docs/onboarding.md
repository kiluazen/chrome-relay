# Onboarding

Chrome Relay is designed around a two-step mental model:

1. Install the extension.
2. Install the local bridge.

## Today

### 1. Build the project

```bash
pnpm install
pnpm build
```

### 2. Register the local bridge

```bash
node packages/cli/dist/cli.js install
```

### 3. Load the extension

Open `chrome://extensions`, enable developer mode, and load:

```text
apps/extension/build/chrome-mv3
```

Open the popup and confirm:

- the store extension ID is `cpdiapbifblhlcpnmlmfpgfjlacebokb`
- local unpacked extension IDs can vary; the installer also allows the current dev IDs used by this workspace
- the native host is connected
- the bridge port is `12122`

### 4. Use the CLI

```bash
node packages/cli/dist/cli.js tabs
node packages/cli/dist/cli.js read -i
```

## Later

The intended user-facing packaging is:

- Chrome Web Store extension named **Chrome Relay**
- `npx skills add kiluazen/kstack@chrome-relay` agent-skill install surface
- a `chrome-relay` skill that explains the CLI setup for agents

The current codebase keeps those surfaces separate:

- store extension name: `Chrome Relay`
- developer CLI/package name: `chrome-relay`
- skill name: `chrome-relay`
