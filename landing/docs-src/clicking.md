---
title: Clicking strategies
description: Three addressing modes, each with a distinct failure mode. Pick by what the page gives you.
nav: Clicking
order: 14
---

There is no single "click" because there is no single way to identify an element across the web. Chrome Relay exposes the strategies as explicit modes instead of hiding them behind a smart wrapper — when something fails, your transcript already contains the diagnosis.

## The ladder

| You have | Use |
|---|---|
| A `@ref` from `snapshot -i` | `chrome-relay click @e12` — default, start here |
| A CSS selector you know statically | `chrome-relay click 'button[aria-label="Save"]'` |
| Pixel coordinates | `chrome-relay click --x 540 --y 320` |
| Only visible text | `js` probe → coordinate click (recipe below) |

All three dispatch the same trusted CDP mouse sequence — hover, press, release, `pointerType: "mouse"`, `isTrusted: true`. Anti-bot heuristics and React-Aria/Radix widgets can't tell them from a human.

## 1. Refs — `click @e12`

The default. Covers buttons, links, inputs, named content, cursor-pointer div-soup (via the [sweep](/docs/snapshots/)), and shadow DOM. Carries its own tab, heals across re-renders, refuses to click through overlays. Full semantics: [Refs](/docs/refs/).

Fails on: real navigation (`stale_ref` → re-snapshot), covered targets (`click_intercepted` → dismiss the overlay), and anything not in the DOM.

## 2. CSS selectors — `click '<selector>'`

```sh
chrome-relay click 'button[aria-label="Save"]' --tab 42
```

For when you already know a stable selector and don't need to look at the page first. Resolution is in-page `querySelector` → scroll into view → center → trusted click.

Fails on: hash-rotated class names (`._3a8K9d`), shadow DOM (querySelector can't pierce; refs can), and selectors you'd have to guess. Failure is `element_not_found` with the selector echoed; malformed CSS is `invalid_arguments`.

## 3. Coordinates — `click --x N --y N`

```sh
chrome-relay js --tab 42 "const r = document.querySelector('svg path').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }"
chrome-relay click --tab 42 --x 312 --y 218
```

The escape hatch for things with no DOM handle at all: canvas UIs and SVG chart internals (anonymous `<path>` segments have no role, no name, and no sane selector — measured 70–100 of them per analytics dashboard). Get fresh coordinates from a `js` rect probe or a screenshot, click immediately — coords go stale the moment the page scrolls.

The contract is deliberately thin: "fire a click at (x, y)". It always reports `clicked: true`; whether it hit something useful is yours to verify.

## Recipe: click by visible text

First try `snapshot -i` — visible text is almost always a node name with a ref next to it. When it genuinely isn't:

```sh
COORDS=$(chrome-relay js --tab 42 "
  const target = 'the text you see';
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    if ((n.textContent || '').includes(target)) {
      const r = n.parentElement.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
  }
  return null;
")
# parse x/y, then: chrome-relay click --tab 42 --x $X --y $Y
```

There's intentionally no `click-text` verb — it would be a smart wrapper hiding which strategy ran.

## Anti-patterns

- **Retrying a stale ref.** `stale_ref` means the page changed; the ref is never coming back. One snapshot fixes it.
- **`js` + `.click()` on clickable elements.** Synthetic event, `isTrusted: false` — silently ignored by anti-bot pages and pointer-event widgets. Use `js` to *find*, trusted verbs to *act*.
- **Coordinate clicks from old data.** Re-read the rect right before clicking, every time.
- **Strategy roulette.** Looping selector → ref → coords until something returns success burns round-trips and eventually clicks the wrong thing. Look at the page (`snapshot -i`), pick once, fail loudly.

## Typing, while you're here

| Target | Tool |
|---|---|
| `<input>` / `<textarea>` / `<select>`, React-controlled, shadow DOM | `fill @ref` — atomic write, bypasses React's value tracker |
| contenteditable, Draft.js, Lexical, ProseMirror (X compose, LinkedIn DM) | `type "text" -s @ref` — trusted insertText at the caret. **Appends** — clear first if the field had a value |
| Enter, Tab, Escape, Cmd+K, arrows | `keys <chord>` |
| Combobox/autocomplete | `type` into the filter → `keys ArrowDown` → `keys Enter` |
