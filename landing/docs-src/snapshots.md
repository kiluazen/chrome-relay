---
title: Snapshots
description: One command turns a page into ~1–15 KB of text where every actionable element has a handle.
nav: Snapshots
order: 12
---

```sh
chrome-relay snapshot --tab <id> -i
```

```
Page: Hacker News
URL: https://news.ycombinator.com/
Tab: 460154464

- link "Hacker News" [ref=e4]
- textbox "Search" [ref=e41]: current value
- checkbox "Remember me" [checked, ref=e42]
- cell "1." [ref=e16]
  - link "MiMo Code Is Now Released and Open-Source" [ref=e19]
- clickable "Open card" [ref=e88]
```

Agents pay context tokens for every byte a tool prints, so the snapshot format exists to be small. Measured: the HN front page is **14 KB** with `-i` (the DOM is 599 KB; the old JSON reader was 61 KB). A typical app view is 1–5 KB.

## The grammar

One line per node, indented to tree depth:

```
- {role} "{name}" [{attrs}]: {value}
```

- `role` — from the accessibility tree: `link`, `button`, `textbox`, `heading`, `cell`…
- `name` — what a screen reader would announce. Quoted, escaped.
- attrs, in order: `level=N`, `checked`/`checked=false`/`checked=mixed`, `expanded`, `selected`, `disabled`, `required`, `readonly`, `pressed`, `ref=eN`, `url=…` (with `-u`)
- `: value` — current input value, only when it differs from the name. A form readback is free with the snapshot; no second round-trip to ask "what does the field say now?"

## What gets a ref

Refs are handles you can [act on](/docs/refs/). Three kinds of node earn one:

1. **Interactive roles** — button, link, textbox, checkbox, combobox, menuitem, tab, … always, even unnamed.
2. **Named content roles** — heading, cell, listitem, img, dialog … only when they have a name (an anonymous heading is noise).
3. **Cursor-interactive sweep finds** — see below.

Anonymous structural nodes (layout divs, unnamed containers) collapse: their children promote up a level. That's most of why the output is small.

## The sweep — catching div-soup

The accessibility tree only knows what page authors told it. Modern Tailwind-style SPAs are full of clickable `<div>`s and `<span>`s with no role: measured on a real app, one email-list view had **37 clickable elements the AX tree couldn't see at all** (cursor-pointer rows, dates, sender names). A well-built dashboard (Cloudflare's, measured) had zero.

So every snapshot also runs a one-pass sweep for elements that *behave* clickable — `cursor: pointer`, `onclick`, `tabindex`, `contenteditable` — deduplicated to the topmost clickable (cursor inherits; you want the row, not its twelve children). They appear as:

```
- clickable "sylvain@zerolooplabs.dev" [ref=e704]
```

Same refs, same actions. Without the sweep, "interactive only" filtering would silently hide real targets — that was the dealbreaker that decided this design.

## Flags

```sh
chrome-relay snapshot --tab <id>             # full tree
chrome-relay snapshot --tab <id> -i          # ref-bearing elements only (use this)
chrome-relay snapshot --tab <id> -d 3        # cap depth
chrome-relay snapshot --tab <id> -s "#main"  # scope to a CSS subtree — refs outside it are never issued
chrome-relay snapshot --tab <id> -u          # include link hrefs as url= attrs
chrome-relay snapshot --tab <id> --json      # structured envelope: { title, url, tabId, nodes, refs }
chrome-relay snapshot --tab <id> --diff      # only what changed since this tab's last snapshot
```

`--diff` attacks the re-snapshot tax directly: after an action, print the handful of changed lines (~100 tokens) instead of the whole page. A full snapshot is still taken and the ref map still refreshes — refs in the diff are current and clickable. Use consistent flags between snapshots (`-i` vs full) or the diff gets noisy.

`--json` includes the full refs map — each ref's `backendNodeId`, role, name — for programmatic callers. The text form is for reading; the JSON form is for building on.

## Frames and shadow DOM

- **Shadow DOM: pierced.** The accessibility tree sees through shadow roots, so web-component internals get refs that `querySelector` could never reach. (Pinned by an e2e test: a `<input>` inside a shadow root gets a ref, and `fill @ref` writes through the boundary.)
- **Same-process iframes: included** — they appear in the tab's AX tree.
- **Cross-origin iframes: not yet.** Snapshot is top-frame scoped for OOPIFs. Coordinate clicks still land in them (input is dispatched at page level); ref/selector addressing doesn't. Stated limitation, on the roadmap.

## Deprecated: `read` and `ax`

Earlier versions had two separate readers (`read` = DOM walk with CSS selectors, `ax` = accessibility tree with its own id space). Both are now aliases for `snapshot` and print a deprecation notice; they'll be removed. If you have scripts parsing the old shapes, switch to `snapshot --json`.
