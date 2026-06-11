---
name: chrome-relay
description: Use when an agent needs to operate the user's real Chrome session — listing tabs, snapshotting the page into actionable @refs, clicking, filling, typing into rich editors, pressing keys, evaluating JS, capturing screenshots, and reading console/network buffers. All actions go through CDP and run on backgrounded tabs without stealing focus.
---

<!--
  MIRROR — canonical source lives in github.com/kiluazen/kstack/skills/chrome-relay.
  This copy exists so the old install command (`npx skills add kiluazen/chrome-relay`)
  shown by older versions of the Chrome extension popup keeps working.
  After editing the canonical version in kstack, run scripts/sync-skill-from-kstack.sh
  to refresh this mirror.
-->

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

Verify CLI ≥ 0.6.0 — that's where the snapshot/@ref loop landed (and ≥ 0.5.20 fixed a silent click bug on Radix/React-Aria UIs):
```sh
chrome-relay --version
```

## The core loop

```sh
chrome-relay tabs                             # find or create a tab
chrome-relay navigate "https://x.com" --new   # background tab by default
chrome-relay snapshot --tab 1234 -i           # see the page: every element gets a @ref
chrome-relay click @e12                       # act on refs — no --tab, no selector
chrome-relay fill @e14 "hello"
chrome-relay snapshot --tab 1234 -i           # re-look after the page changes
```

Snapshot output is compact indented text (~1–15 KB for most pages) — read it directly, no jq needed:

```
- link "Hacker News" [ref=e4]
- textbox "Search" [ref=e41]: current value
- checkbox "Remember me" [checked, ref=e42]
- clickable "Open card" [ref=e88]        ← cursor-pointer div the AX tree missed
```

**Refs carry their own tab.** `click @e12` acts on the tab that produced e12, never the active tab — safe while the user keeps browsing. A contradicting `--tab` errors with `target_conflict`.

**Ref lifetime.** Refs survive same-page DOM churn (cached backendNodeId, healed by role+name re-find when nodes are replaced) but die on real navigation. A dead ref returns `error.code = stale_ref` → re-run `snapshot`.

## Tool surface

| Command | What it does |
|---|---|
| `tabs` | List windows + tabs with their `tabId`s |
| `navigate <url>` | Open in current tab. `--new` opens in a **background** tab (default). `--active` brings it to foreground. `--tab <id>` retargets an existing tab. |
| `snapshot --tab <id> -i` | Page snapshot with actionable `@refs` — accessibility tree + cursor-interactive sweep, one ref space, compact text. `-d N` depth cap, `-s <css>` scope to subtree, `-u` include hrefs, `--json` structured envelope with the refs map. |
| `click <@ref \| selector> --tab <id>` | Trusted hover + press + release at element center (`pointerType: "mouse"`). Refs need no `--tab`. |
| `click --x N --y N --tab <id>` | Coordinate-mode click — for canvas/SVG chart internals with no DOM handle. |
| `hover <@ref \| selector \| --x --y>` | Pointer move only — fires `:hover` styles. |
| `fill <@ref \| selector> <value>` | Atomic value write into `<input>`/`<textarea>`/`<select>`. Bypasses React's value tracker. Refs reach inside shadow DOM (selectors can't). |
| `type <text> [-s <@ref \| selector>]` | CDP `Input.insertText`. Use for contenteditable / Draft.js / Lexical / ProseMirror. **Appends** at caret; clear the input first if it had a value. |
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
| `read` / `ax` / `click-ax` | **Deprecated** — aliases for `snapshot` / `click @ref`. Will be removed; don't use in new work. |

## Picking the right text tool

| Target element | Tool |
|---|---|
| `<input>`, `<textarea>`, `<select>` (including React-controlled, shadow DOM) | `fill @ref` |
| `[contenteditable]`, `role="textbox"`, Draft.js / Lexical / ProseMirror, X compose, LinkedIn DM, new Reddit composer | `type` |
| Submit, navigate menus, modifier shortcuts | `keys` |
| Combobox / autocomplete option selection | `type` into filter → `keys ArrowDown` → `keys Enter` ([why](references/patterns.md)) |
| Framework-internal pokes, scraping, custom widgets | `js` |

## Element addressing — the fallback ladder

1. **`@ref` from `snapshot -i`** — default. Covers buttons/links/inputs, named content, cursor-pointer div-soup (the sweep), and shadow DOM.
2. **CSS selector** — when you know the selector statically and don't need a snapshot.
3. **`js` probe → coordinate click** — canvas internals and SVG chart segments (anonymous `<path>` elements have no DOM handle anywhere):
   ```sh
   chrome-relay js --tab 1234 "const r = document.querySelector('svg path').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}"
   chrome-relay click --tab 1234 --x 312 --y 218
   ```

## Top gotchas

1. **`type` appends** — it inserts at the caret. If the input had a value (autosaved draft, default text), clear it first via `js` or `keys` (Cmd+A then Backspace).
2. **Refs die on navigation** — `stale_ref` means the page changed under you; re-snapshot. Don't retry the same ref.
3. **Coords go stale fast** — read `getBoundingClientRect`, scroll/reflow, then click → you hit the wrong element. For autocomplete popups especially, use keyboard nav, not coord clicks.
4. **Click "succeeded" but nothing happened** — first diagnostic: `document.elementFromPoint(x, y)`. If it returns a wrapper or form background, your coords are wrong. If it returns the right element but state didn't change, you're likely on chrome-relay <0.5.20 — upgrade.

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

- Errors are structured: branch on `relayError.code` (`stale_ref`, `element_not_found`, `target_conflict`, `timeout`), not on message text.
- If a flag is unclear, `chrome-relay <command> --help` is authoritative — these docs lag.
