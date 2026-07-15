---
name: chrome-relay
description: Use when an agent needs to operate the user's real Chrome session: listing tabs, snapshotting the page into actionable @refs, clicking, filling, typing into rich editors, pressing keys, evaluating JS, capturing screenshots, and reading console/network buffers. All actions go through CDP and run on backgrounded tabs without stealing focus.
---

<!--
  MIRROR: canonical source lives in github.com/kiluazen/kstack/skills/chrome-relay.
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
   npm install -g chrome-relay@latest
   chrome-relay install
   chrome-relay --version
   chrome-relay doctor
   ```

Use the latest CLI. Multi-browser/profile routing and uploads require >= 0.8.0; Dia detection and the agent-friendly profile picker require >= 0.8.1. If the printed version stays below 0.8 after installing, stop and resolve the stale binary on `PATH` before using 0.8 commands:
```sh
chrome-relay --version
which -a chrome-relay        # macOS/Linux; use `where chrome-relay` on Windows
```

At the start of a session, run `chrome-relay profile list`. With one connected instance, normal commands need no profile flag. With several, this tells you exactly which browsers and profiles are reachable before you act.

## The core loop

```sh
chrome-relay tabs                             # find or create a tab
chrome-relay navigate "https://kushalsm.com" --new   # background tab by default
chrome-relay snapshot --tab 1234 -i           # see the page: actionable elements get @refs
chrome-relay click @e12                       # act on refs, no --tab, no selector
chrome-relay fill @e14 "hello"
chrome-relay wait --text "Saved" --tab 1234   # block until the page reacts
chrome-relay snapshot --tab 1234 --diff       # print only what changed (~100 tokens)
```

Snapshot output is compact indented text, usually 1 to 15 KB for most pages. Read it directly, no jq needed:

```
- link "Hacker News" [ref=e4]
- textbox "Search" [ref=e41]: current value
- checkbox "Remember me" [checked, ref=e42]
- clickable "Open card" [ref=e88]        # cursor-pointer div the AX tree missed
```

**Refs carry their own tab.** `click @e12` acts on the tab that produced e12, never the active tab. Safe while the user keeps browsing. A contradicting `--tab` errors with `target_conflict`.

**Ref lifetime.** Refs survive same-page DOM churn (cached backendNodeId, healed by role+name re-find when nodes are replaced) but die on real navigation. A dead ref returns `error.code = stale_ref`. Re-run `snapshot`.

**Interception.** Ref clicks hit-test the point first. If an overlay / sticky header / modal owns it, you get `error.code = click_intercepted` naming the interceptor. Dismiss it or scroll, then retry. The click was NOT delivered. `fill`/`type` skip this check (covered inputs are still writable).

## Tool surface

| Command | What it does |
|---|---|
| `tabs` | List windows + tabs with their `tabId`s |
| `navigate <url>` | Open in current tab. `--new` opens in a **background** tab (default). `--active` brings it to foreground. `--tab <id>` retargets an existing tab. |
| `snapshot --tab <id> -i` | Page snapshot with actionable `@refs`: accessibility tree plus cursor-interactive sweep, one ref space, compact text. `-d N` depth cap, `-s <css>` scope to subtree, `-u` include hrefs, `--diff` print only changes since the last snapshot, `--json` structured envelope with the refs map. |
| `wait <css\|@ref>` / `wait --text` / `--url <glob>` / `--load networkidle` / `--fn <js>` | Block until a condition holds (one per call, default 10s, max 25s). `wait 1500` just sleeps. On timeout the error includes current page state. |
| `get text\|value\|attr\|count\|title\|url <target>` | One value, plain to stdout. No full snapshot. `get text @e12`, `get attr @e7 href`, `get count ".row"`. |
| `batch '[{"name":"chrome_...","args":{...}}, ...]'` | N tool calls in ONE round-trip, sequential, bail-on-error by default. Use wire tool names. |
| `skills get core` | Print this playbook, version-matched to the installed binary. |
| `click <@ref \| selector> --tab <id>` | Trusted hover + press + release at element center (`pointerType: "mouse"`). Refs need no `--tab`. |
| `click --x N --y N --tab <id>` | Coordinate-mode click for canvas/SVG chart internals with no DOM handle. |
| `hover <@ref \| selector \| --x --y>` | Pointer move only. Fires `:hover` styles. |
| `fill <@ref \| selector> <value>` | Atomic value write into `<input>`/`<textarea>`/`<select>`. Bypasses React's value tracker. Refs reach inside shadow DOM (selectors can't). |
| `type <text> [-s <@ref \| selector>]` | CDP `Input.insertText`. Use for contenteditable / Draft.js / Lexical / ProseMirror. **Appends** at caret; clear the input first if it had a value. |
| `keys <chord> --tab <id>` | Single key or chord: `Enter`, `Tab`, `Escape`, `Cmd+K`, `Shift+ArrowDown`. |
| `js <code> --tab <id>` | `Runtime.evaluate` in MAIN world. Use `return` for the value. Top-level `await` works. |
| `screenshot --tab <id> -o <path>` | PNG. `--full` captures beyond viewport. `--max-edge N` resizes. |
| `screencast --tab <id> -o <path>` | Record a tab via CDP (paint-driven). Requires an active tab. |
| `network --tab <id>` | HTTP request/response ring buffer, last 200 per tab. `network body <requestId>` fetches a body while Chrome still has it. `network har --with-bodies` exports a HAR with bodies. |
| `console --tab <id>` | `console.log/warn/error` + page exceptions, last 200. |
| `viewport` | Emulate device viewport, DPR, mobile flag, touch, UA. |
| `workspace` / `group` | Manage named windows / tab-groups so multiple agents can drive separate windows. |
| `switch <tabId>` / `close <tabIds...>` | Activate or close tabs |
| `self-reload` | Restart the extension's service worker after a rebuild |
| `release-notes --since <ver>` / `update` | Queryable changelog; agent-readable JSON. |
| `call <tool> [json]` | Raw pass-through for any internal tool. |
| `read` / `ax` / `click-ax` | **Deprecated**. Aliases for `snapshot` / `click @ref`. Will be removed; don't use in new work. |

## Picking the right text tool

| Target element | Tool |
|---|---|
| `<input>`, `<textarea>`, `<select>` (including React-controlled, shadow DOM) | `fill @ref` |
| `[contenteditable]`, `role="textbox"`, Draft.js / Lexical / ProseMirror, X compose, LinkedIn DM, new Reddit composer | `type` |
| Submit, navigate menus, modifier shortcuts | `keys` |
| Combobox / autocomplete option selection | `type` into filter, then `keys ArrowDown`, then `keys Enter` ([why](references/patterns.md)) |
| Framework-internal pokes, scraping, custom widgets | `js` |

## Many browsers & profiles (CLI >= 0.8)

The primary supported targets are Google Chrome (including multiple Chrome profiles), Dia, and Brave. One CLI reaches every connected instance where the extension is installed; each Chrome profile is a separate addressable instance.

The installer also knows native-host manifest paths for Chrome Canary, Chromium, Edge, Vivaldi, Arc, and Opera. Treat those as compatibility targets unless the current task has verified them; do not claim that manifest detection alone proves full browser support.

Install the extension once in every browser/profile you want reachable, then run `chrome-relay install` once so every detected browser can spawn its own host.

```sh
chrome-relay profile list             # who's connected: label, browser, id prefix
chrome-relay profile label work       # one connected: label it directly
chrome-relay --profile 3f2a profile label personal  # several: first pick by id prefix
chrome-relay --profile work tabs      # scope any command (global or per-command flag)
chrome-relay click @3f2a:e12          # snapshot refs are profile-qualified and route by THEMSELVES
```

One instance connected: no flags, everything routes implicitly. Several: unscoped commands fail `profile_ambiguous`. Treat the error as a picker: choose one of its exact `--profile <label|idprefix>` entries and rerun the command. It never guesses. Refs carry their profile the way they carry their tab, so after one `snapshot` you rarely need the flag again. Free a stale label with `chrome-relay profile unlabel <name>`.

## Uploads (CLI >= 0.8)

Three strategies, no auto-fallback — the failure names the strategy, pick the next:

```sh
chrome-relay upload set --selector 'input[type=file]' --tab 123 ./cv.pdf   # direct; works on HIDDEN inputs
chrome-relay upload choose --click-ref @e4 ./cv.pdf   # trigger opens the OS picker: intercepted, NO dialog appears
chrome-relay upload drop --selector '.dropzone' ./avatar.png
```

Files are paths — Chrome reads them itself, no size caps. `not_a_file_input` → use choose. `no_file_chooser` → wrong trigger, or it's a drop zone. `file_access_denied` → chrome://extensions → Chrome Relay → "Allow access to file URLs". set/choose return what the input ACTUALLY holds after the call.

## Element addressing: the fallback ladder

1. **`@ref` from `snapshot -i`**: default. Covers buttons/links/inputs, named content, cursor-pointer div-soup (the sweep), and shadow DOM.
2. **CSS selector**: when you know the selector statically and don't need a snapshot.
3. **`js` probe, then coordinate click**: canvas internals and SVG chart segments (anonymous `<path>` elements have no DOM handle anywhere):
   ```sh
   chrome-relay js --tab 1234 "const r = document.querySelector('svg path').getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}"
   chrome-relay click --tab 1234 --x 312 --y 218
   ```

## Don't poll. Wait.

A snapshot after every action wastes turns. The cheap loop on a changing page:

```sh
chrome-relay click @e12
chrome-relay wait --text "Saved" --tab 1234     # or wait <selector> / --url / --load
chrome-relay snapshot --tab 1234 --diff         # only the changes, refs included
```

## Top gotchas

0. **`snapshot -i` is for ACTING, not fact extraction.** It prints ref-bearing elements only. Non-interactive values (dashboard metrics, paragraph text, chart labels) drop out. Measured live: a Cloudflare Pages metrics page lost all its numbers under `-i`. To READ facts, use full `snapshot`, `get text <target>`, or a `js` projection.
1. **`type` appends.** It inserts at the caret. If the input had a value (autosaved draft, default text), clear it first via `js` or `keys` (Cmd+A then Backspace).
2. **Refs die on navigation.** `stale_ref` means the page changed under you; re-snapshot. Don't retry the same ref.
3. **Coords go stale fast.** Read `getBoundingClientRect`, scroll/reflow, then click, and you hit the wrong element. For autocomplete popups especially, use keyboard nav, not coord clicks.
4. **Click "succeeded" but nothing happened.** First diagnostic: `document.elementFromPoint(x, y)`. If it returns a wrapper or form background, your coords are wrong. If it returns the right element but state didn't change, you're likely on chrome-relay <0.5.20. Upgrade.

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
- **Don't echo secrets.** When extracting tokens / API keys via `js`, write the result directly to a file. Never `echo $TOKEN` or interpolate into shell strings. It ends up in scrollback, logs, and tool transcripts.
- **Redact `network` output.** Request/response headers carry cookies, auth/CSRF tokens, account and project IDs. Never paste raw `chrome-relay network` output into chat, docs, issues, or commits. Filter to the fields you need (url, status, timings) or redact headers first.
- **Capture before irreversible actions** (form submit, send message, account change). Save the screenshot path.

## Guardrails

- Errors are structured: branch on `relayError.code` (`stale_ref`, `click_intercepted`, `element_not_found`, `target_conflict`, `profile_ambiguous`, `timeout`), not on message text.
- If a flag is unclear, `chrome-relay <command> --help` is authoritative. These docs lag.
