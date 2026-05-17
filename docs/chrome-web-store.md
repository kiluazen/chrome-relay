# Chrome Web Store Listing Notes

The Chrome Web Store listing is published at:

```text
https://chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb
```

The extension package is named **Chrome Relay** in the manifest; the developer CLI and install command remain `chrome-relay`.

## Build

```bash
pnpm install
pnpm typecheck
pnpm store:zip
```

Upload the zip from:

```text
apps/extension/build/chrome-relay-extension-<version>-chrome.zip
```

The filename's `<version>` matches `apps/extension/package.json`'s `version`
field, which WXT writes into the built manifest.

## Single Purpose

Chrome Relay connects the user's local browser profile to local coding agents through a native messaging host and a local bridge. It lets the user's own agent list tabs, navigate pages, read visible page structure, click, fill forms, type keys, and capture screenshots.

It does not provide a cloud account, remote relay, ad network, analytics SDK, or embedded chat assistant.

## Permission Justifications

`nativeMessaging`

Required to connect the extension to the locally installed `chrome-relay` native host. The native host starts the local bridge and relays tool calls between the user's agent and the extension.

`debugger`

Required to drive the Chrome DevTools Protocol (CDP) from the extension's
service worker. Every page interaction the user's local agent issues —
trusted keyboard/mouse input via `Input.dispatchKeyEvent` /
`Input.dispatchMouseEvent`, viewport emulation via `Emulation.*`, network
metadata capture via `Network.*`, accessibility-tree reads via
`Accessibility.*`, console capture via `Runtime.consoleAPICalled`, region
screenshots via `Page.captureScreenshot` — goes through CDP. The extension
only attaches when an explicit local tool call asks for it and only against
the targeted tab; nothing is logged or sent off-device.

`tabs`

Required to list open tabs, activate a selected tab, navigate a tab, close selected tabs, and return tab IDs to the user's local agent.

`tabGroups`

Required to manage Chrome's native tab-groups (the colored, collapsible
folders the user sees in their tab bar). Used by `chrome-relay group …`
to create/list/close/add/remove named tab-groups so the local agent can
visually bundle the tabs it's working on inside the user's own window.
No off-device transmission; group memberships stay in Chrome's local
extension storage.

`storage`

Required to persist tab-group definitions (named windows the local agent
targets via `--group <name>`) across service-worker restarts and to store
the last few tool execution summaries shown in the popup. Storage stays in
Chrome's local extension storage; nothing is sent off-device.

`host_permissions: <all_urls>`

Required because the user may ask their local agent to operate any website currently open in their browser profile. The extension injects only its bundled page helpers and only when a local bridge call asks it to read, click, fill, type, or screenshot.

## Data Disclosure

Suggested dashboard disclosure:

- Website content: yes. The extension can read visible page text and interactive element metadata when the local user/agent calls `chrome_read_page`.
- Web history: yes. The extension can list currently open tab titles and URLs so the local agent can target the right tab.
- Authentication information: no collection by the extension itself, but the extension operates in the user's existing browser profile and can interact with logged-in pages at the user's direction.
- Personally identifiable information: no separate account collection. Page content may contain personal data if the user directs their agent to read or interact with those pages.

Data handling statement:

Chrome Relay does not send browsing data to a Chrome Relay cloud service. Tool calls and results pass between the Chrome extension, the local native host, and the user's configured local CLI or coding agent. Recent tool execution summaries are stored locally in Chrome extension storage.

## Remote Code

Declare: no remote code.

The published extension contains its JavaScript bundle and does not load scripts from remote URLs. Generic JavaScript evaluation is intentionally not part of the Chrome Web Store tool surface.

## Reviewer Test Instructions

1. Install the extension from the Chrome Web Store.
2. Install the native host CLI:

   ```bash
   pnpm add -g chrome-relay
   chrome-relay install
   ```

3. Open the extension popup and confirm it shows `Native host connected`.
4. Run:

   ```bash
   chrome-relay doctor
   chrome-relay tabs
   chrome-relay read -i
   ```

5. The popup should show the most recent tool executions.

## Assets

Required assets:

- Extension icon: `apps/extension/public/icons/icon-128.png`
- Small promo image: `store/assets/small-promo.png`
- Source artwork: `store/assets/icon.svg` and `store/assets/small-promo.svg`

Recommended screenshots:

- Popup connected state.
- CLI `chrome-relay tabs` output beside a browser window.
- Form-fill demo on a harmless test page.

## Trademark Note

Listing text should avoid implying Google affiliation. If needed, say "works with your local Chrome browser" and include Google's trademark attribution in the listing copy.
