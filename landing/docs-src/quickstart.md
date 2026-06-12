---
title: Quickstart
description: The snapshot → ref → act loop, end to end, with real output.
nav: Quickstart
order: 2
---

Everything an agent does with Chrome Relay is one loop: look at the page, act on what you saw, look again. This page runs it once, for real.

## Open a page in the background

```sh
chrome-relay navigate "https://news.ycombinator.com" --new
```

```json
{ "tabId": 460154464, "windowId": 460153891 }
```

`--new` opens a **background** tab — the user's focus is never stolen. Keep the `tabId`.

## Look at the page

```sh
chrome-relay snapshot --tab 460154464 -i
```

```
Page: Hacker News
URL: https://news.ycombinator.com/
Tab: 460154464

- link "Hacker News" [ref=e4]
- link "new" [ref=e5]
- link "past" [ref=e7]
- cell "1." [ref=e16]
- cell "MiMo Code Is Now Released and Open-Source (xiaomi.com)" [ref=e18]
  - link "MiMo Code Is Now Released and Open-Source" [ref=e19]
  - link "xiaomi.com" [ref=e20]
...
```

`-i` prints only actionable elements. The whole front page is ~14 KB of this. Every `[ref=eN]` is a handle you can act on.

## Act on a ref

```sh
chrome-relay click @e5
```

```json
{ "clicked": true, "x": 250, "y": 20, "ref": "e5", "tabId": 460154464 }
```

No `--tab`. No CSS selector. The ref knows which tab it came from — it acts there even if you (the human) are reading a different tab right now.

## Fill, type, press

```sh
chrome-relay fill @e41 "search term"     # inputs, textareas, selects — atomic write
chrome-relay type "hello" -s @e23        # contenteditable / Lexical / ProseMirror
chrome-relay keys Enter --tab 460154464  # chords: Cmd+K, Shift+ArrowDown, Escape
```

## Look again

After anything that changes the page, re-snapshot:

```sh
chrome-relay snapshot --tab 460154464 -i
```

Refs survive same-page DOM churn (a toast appearing won't kill them — there's a heal step that re-finds moved nodes). They **die on navigation**, on purpose. If you act on a dead one:

```json
{ "relayError": { "code": "stale_ref",
  "message": "chrome_click_element: @e19 is not a known ref (...). Re-run `chrome-relay snapshot` and use a fresh ref." } }
```

The fix is always the same: snapshot again. See [Refs](/docs/refs/) for the full lifetime rules.

## Capture proof

```sh
chrome-relay screenshot --tab 460154464 -o /tmp/evidence.png
```

Works on background tabs without activating them.

## The loop, named

```
snapshot -i  →  click/fill @ref  →  snapshot -i  →  ...
```

That's the whole interface. Three more things worth knowing before you go deep:

- `js` runs arbitrary JavaScript in the page when the DOM doesn't expose what you need: `chrome-relay js --tab <id> "return document.title"`
- Errors are structured — branch on `relayError.code`, never regex the message. [Error reference](/docs/errors/).
- For everything the CLI can do: [Command reference](/docs/commands/).
