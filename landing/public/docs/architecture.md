# Architecture

> Five hops, each with one job. Why the extension route is the only safe way into a running Chrome.


```
agent (any shell)
  → chrome-relay CLI            parses args, renders output
  → instance registry           discovers and verifies connected profiles
  → localhost HTTP              authenticated ephemeral port for one profile
  → native messaging host       one process spawned by that extension instance
  → extension service worker    that browser/profile's tools, refs, buffers
  → chrome.debugger (CDP)       trusted input, snapshots, capture
  → your tabs
```

Every hop is local. The wire format is one JSON envelope per call: `{ name, args }` in, `{ ok, data } | { ok: false, errorDetails }` out.

Each browser profile running the extension spawns its own native host. The host registers an authenticated ephemeral localhost port under `~/.chrome-relay/instances/`; every CLI call verifies those descriptors, resolves exactly one profile, and sends the command there. With one connected profile this is invisible. With several, `--profile <label|idprefix>` chooses one and profile-qualified refs such as `@3f2a:e12` route themselves. Port `12122` exists only as a legacy compatibility path for pre-0.8 installations.

## Why not `--remote-debugging-port`?

The standard way tools attach to a real Chrome is launching it with a CDP debug port. Two problems:

1. **You have to relaunch Chrome.** Your running session — every tab, every WebSocket, every half-written form — dies so the flag can take effect.
2. **The port is a skeleton key.** Anything on your machine that can reach `localhost:9222` gets the full protocol: read any cookie, open any URL, in every profile window. No permission prompt, no scoping.

The extension + native-messaging route inverts both. It attaches to the *already running* browser, and the only process that can talk to the extension is the one binary whitelisted in the native-messaging manifest — a file Chrome itself verifies. The browser's own permission model is the gate.

The cost is more moving parts (install registers the host; the extension must be present). `chrome-relay doctor` exists because of that cost.

## What lives where

| Piece | Owns |
|---|---|
| **CLI** (`chrome-relay`, npm) | argument parsing, profile discovery/routing, output rendering (snapshot text, JSON), exit codes. Stateless — every invocation resolves one host and makes one HTTP call. |
| **Protocol** (bundled into the CLI) | tool names, argument schemas, error codes, the snapshot renderer. One source of truth both ends import. |
| **Native host** | spawned once per extension instance on `connectNative()`; registers its authenticated localhost endpoint and relays frames. |
| **Extension** | everything that touches the browser: the [ref map](/docs/refs/), the [snapshot builder](/docs/snapshots/), per-tab console/network ring buffers, CDP sessions, trusted input dispatch. |

## Security model

- **Localhost only.** The bridge binds `127.0.0.1`. It also rejects requests carrying a browser `Origin` header, so a web page you visit can't script your own bridge.
- **No cloud, no account, no telemetry.** There is nothing to sign into and nowhere for your data to go. The extension's only outbound channel is native messaging to your own machine.
- **Chrome-verified pairing.** The native-messaging manifest whitelists exact extension IDs; Chrome enforces it in both directions.
- **One trust decision.** Installing Chrome Relay means: processes on my machine that can run `chrome-relay` may drive my browser. That's the honest statement of the model — the same trust you extend to anything you `npm i -g`. If your threat model can't accept it, use a sandboxed browser instead ([when not to use this](/docs/why-your-real-chrome/)).

## Trusted input, specifically

Clicks and keys go through CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`, so the page receives `isTrusted: true` events with `pointerType: "mouse"` — indistinguishable from a human. This matters on real apps: React-Aria/Radix widgets listen for pointer events and ignore synthetic `.click()`; login and payment flows gate on trusted events. JS-side `.click()` is available via `chrome-relay js` when you want it, but it's the fallback, not the path.

## Background tabs that act foregrounded

Chrome throttles and hides backgrounded tabs (`document.hidden`, paused rAF, visibility events). The extension patches visibility APIs on relay-driven tabs so pages behave normally while the agent works and you keep your focus elsewhere. The one hard limit: Chrome doesn't *paint* background tabs, so `screencast` (video capture) needs the tab active — screenshots don't.
