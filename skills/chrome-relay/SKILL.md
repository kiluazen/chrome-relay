---
name: chrome-relay
description: Use when an agent needs to operate the user's real Chrome session — listing tabs, reading the page, clicking, filling, typing into rich editors, pressing keys, evaluating JS, capturing screenshots, and reading console/network buffers. All actions go through CDP and run on backgrounded tabs without stealing focus.
---

# Chrome Relay

Drives the user's real Chrome through a Chrome extension + local native host. Prefer it when logged-in browser state (auth cookies, sessions, installed extensions) matters.

## Setup

1. [Chrome extension](https://chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb)
2. CLI:
   ```sh
   pnpm add -g chrome-relay
   chrome-relay install
   chrome-relay doctor
   ```

Verify CLI ≥ 0.5.20 — earlier versions have a silent click bug on Radix/React-Aria UIs:
```sh
chrome-relay --version
```

## Tool surface

| Command | What it does |
|---|---|
| `tabs` | List windows + tabs with their `tabId`s |
| `navigate <url>` | Open in current tab. `--new` opens in a **background** tab (default). `--active` brings it to foreground. `--tab <id>` retargets an existing tab. |
| `read --tab <id> -i` | Interaction map: visible interactive elements with selectors, text, role, bounds. Pipe to file. |
| `ax --tab <id>` | Accessibility tree — ~30× smaller than `read`, more semantic. Returns `backendDOMNodeId`s. |
| `click <selector> --tab <id>` | Trusted hover + press + release at element center (CDP `Input.dispatchMouseEvent` with `pointerType: "mouse"`). |
| `click --x N --y N --tab <id>` | Coordinate-mode click. Selector optional. |
| `click-ax --node <backendDOMNodeId> --tab <id>` | Click an element resolved from a prior `ax` call. |
| `hover [selector \| --x --y] --tab <id>` | Pointer move only — fires `:hover` styles. |
| `fill <selector> <value> --tab <id>` | Atomic value write into `<input>`/`<textarea>`/`<select>`. Bypasses React's value tracker. |
| `type <text> --tab <id> [-s <selector>]` | CDP `Input.insertText`. Use for contenteditable / Draft.js / Lexical / ProseMirror. **Appends** at caret; clear the input first if it had a value. |
| `keys <chord> --tab <id>` | Single key or chord: `Enter`, `Tab`, `Escape`, `Cmd+K`, `Shift+ArrowDown`. |
| `js <code> --tab <id>` | `Runtime.evaluate` in MAIN world. Use `return` for the value. Top-level `await` works. |
| `screenshot --tab <id> -o <path>` | PNG. `--full` captures beyond viewport. `--max-edge N` resizes. |
| `screencast --tab <id> -o <path>` | Record a tab via CDP (paint-driven). Requires an active tab. |
| `network --tab <id>` | HTTP request/response ring buffer, last 200 per tab. `network read --request-id <id>` for bodies. |
| `console --tab <id>` | `console.log/warn/error` + page exceptions, last 200. |
| `viewport` | Emulate device viewport, DPR, mobile flag, touch, UA. |
| `workspace` / `group` | Manage named windows / tab-groups so multiple agents can drive separate windows. |
| `switch <tabId>` / `close <tabIds...>` | Activate or close tabs |
| `self-reload` | Restart the extension's service worker after a rebuild |
| `release-notes --since <ver>` / `update` | Queryable changelog; agent-readable JSON. |
| `call <tool> [json]` | Raw pass-through for any internal tool. |

## Picking the right text tool

| Target element | Tool |
|---|---|
| `<input>`, `<textarea>`, `<select>` (including React-controlled) | `fill` |
| `[contenteditable]`, `role="textbox"`, Draft.js / Lexical / ProseMirror, X compose, LinkedIn DM, new Reddit composer | `type` |
| Submit, navigate menus, modifier shortcuts | `keys` |
| Combobox / autocomplete option selection | `type` into filter → `keys ArrowDown` → `keys Enter` ([why](references/patterns.md)) |
| Shadow DOM, framework-internal pokes, scraping, custom widgets | `js` |

## Workflow

1. Find the tab — `chrome-relay tabs`
2. Open the page — `chrome-relay navigate "https://example.com" --new` (background by default)
3. Read structure — pipe to a file, don't dump 100KB into context:
   ```sh
   chrome-relay read --tab 1234 -i > /tmp/page.json
   jq '.elements[] | select(.text | test("Compose"; "i"))' /tmp/page.json
   ```
   For dense apps (LinkedIn, Notion), prefer `ax` — way smaller payload.
4. Act on the selectors:
   ```sh
   chrome-relay click "<selector>" --tab 1234
   chrome-relay fill "<selector>" "value" --tab 1234
   chrome-relay type "tweet body" --tab 1234 -s "[data-testid=tweetTextarea_0]"
   chrome-relay keys "Enter" --tab 1234
   ```
5. Drop to `js` when the DOM doesn't expose what you need:
   ```sh
   chrome-relay js --tab 1234 "return document.title"
   chrome-relay js --tab 1234 "const r = await fetch('/api/me'); return await r.json()"
   ```
6. Capture proof — `chrome-relay screenshot --tab 1234 -o /tmp/evidence.png`

## Top gotchas

1. **`type` appends** — it inserts at the caret. If the input had a value (autosaved draft, default text), clear it first via `js` or `keys` (Cmd+A then Backspace).
2. **Coords go stale fast** — read `getBoundingClientRect`, scroll/reflow, then click → you hit the wrong element. For autocomplete popups especially, use keyboard nav, not coord clicks.
3. **Click "succeeded" but nothing happened** — first diagnostic: `document.elementFromPoint(x, y)`. If it returns a wrapper or form background, your coords are wrong. If it returns the right element but state didn't change, you're likely on chrome-relay <0.5.20 — upgrade.

More recipes: [references/patterns.md](references/patterns.md)
Failure modes: [references/troubleshooting.md](references/troubleshooting.md)

## Operational guidance

- **Don't give up early.** A failing click is information, not a stop signal. Attach a document-level listener with `capture:true` and watch what fires:
  ```sh
  chrome-relay js --tab 1234 "
    ['pointerdown','mousedown','click'].forEach(t =>
      document.addEventListener(t, e => console.log(t, e.target.tagName, e.target.className), {capture:true})
    );
    return 'listening'
  "
  # do the action, then:
  chrome-relay console --tab 1234
  ```
- **Don't echo secrets.** When extracting tokens / API keys via `js`, write the result directly to a file. Never `echo $TOKEN` or interpolate into shell strings — it ends up in scrollback, logs, and tool transcripts.
- **Capture before irreversible actions** (form submit, send message, account change). Save the screenshot path.

## Guardrails

- Pipe `read -i` to a file and grep/jq it. Don't paste the full element map into chat.
- If a flag is unclear, `chrome-relay <command> --help` is authoritative — these docs lag.
