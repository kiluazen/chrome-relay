# Chrome Relay docs

> Your agent drives the Chrome you're signed into — reads pages, clicks buttons, fills forms. Nothing leaves the machine.


Chrome Relay lets a terminal agent — Claude Code, Codex, anything that runs shell commands — operate your real Chrome. Not a headless automation browser with an empty profile: the actual browser you're signed into, with your cookies, SSO sessions, extensions, and localhost tabs. It works on background tabs without stealing focus, so you keep browsing while the agent works.

```sh
chrome-relay tabs                             # find or open a tab
chrome-relay navigate "https://kushalsm.com" --new   # opens in the background
chrome-relay snapshot --tab 1234 -i           # see the page: actionable elements get @refs
chrome-relay click @e12                       # act on a ref — no selectors, no --tab
chrome-relay fill @e14 "hello"
chrome-relay snapshot --tab 1234 -i           # look again after the page changes
```

That's the whole loop. A snapshot of the Hacker News front page is ~14 KB of plain text. A click round-trip is ~150 ms.

## What it is, in one diagram

```
your agent (terminal)
  → chrome-relay CLI
  → localhost HTTP (127.0.0.1:12122)
  → native messaging host
  → Chrome extension (service worker)
  → CDP (chrome.debugger)
  → your real tabs
```

Everything is local. There is no cloud relay, no account, no telemetry. The extension talks to one whitelisted local process through Chrome's own native-messaging permission system — the same Chrome you'd have to trust anyway.

## Where to go

| You want to | Read |
|---|---|
| Install it | [Installation](/docs/installation/) |
| Drive a page in 2 minutes | [Quickstart](/docs/quickstart/) |
| Understand why it uses *your* Chrome | [Why your real Chrome](/docs/why-your-real-chrome/) |
| Know how the pieces connect | [Architecture](/docs/architecture/) |
| Read pages cheaply | [Snapshots](/docs/snapshots/) |
| Click things reliably | [Refs](/docs/refs/) · [Clicking strategies](/docs/clicking/) |
| Look up a command | [Command reference](/docs/commands/) |
| Teach your agent | [The agent skill](/docs/skill/) |
| Compare with agent-browser | [vs agent-browser](/docs/vs-agent-browser/) |

## Design positions, briefly

- **CLI, not MCP.** Tool schemas cost thousands of context tokens on every agent turn; a CLI costs nothing until invoked, and every agent already knows how to run shell commands.
- **Verbs, not magic.** There's no "smart click" with hidden fallbacks. Each addressing mode (`@ref`, CSS selector, coordinates) is explicit, and each failure is a structured error code the agent can branch on.
- **Strict by default.** No silent partial success. If a click would land on an overlay instead of the target, you get `click_intercepted` naming the overlay — not a success report and a broken page.
- **Output is the product.** Agents pay for every byte on stdout. The snapshot format exists to be small.
