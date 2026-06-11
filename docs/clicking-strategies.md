# Click strategies — how chrome-relay clicks things

There is no single "click" because there is no single way to identify an element across the web. Each strategy below is a separate addressing mode in chrome-relay's CLI. Per [the CLI philosophy](./cli-philosophy.md): we expose verbs, the agent picks the right one for the site profile.

## TL;DR — the ladder

| Agent has | Verb |
|---|---|
| A `@ref` from `snapshot -i` | `chrome-relay click @e12` — **default, start here** |
| A CSS selector known statically | `chrome-relay click '<selector>'` |
| Pixel coordinates | `chrome-relay click --x N --y N` |
| Visible text on the page (no ref, no selector) | `js` + `click --x/y` (see [recipe](#recipe-click-by-visible-text)) |
| Anything weird (framework internals, canvas) | `chrome-relay js "<code>"` |

## Each strategy in depth

### 1. Snapshot ref — `chrome-relay click @e12`

```bash
chrome-relay snapshot --tab 42 -i      # every actionable element gets a ref
chrome-relay click @e12                # no --tab, no selector
chrome-relay fill @e14 "value"         # same refs work for fill/hover/type
```

Ref-bearing = interactive roles (always), named content roles (heading, cell, listitem…), and cursor-interactive sweep extras. Anonymous structural nodes don't get refs — there's nothing to do with them.

**Under the hood:**
1. `snapshot` builds the accessibility tree + a cursor-interactive sweep (div-soup clickables the AX tree misses), assigns each ref-bearing node a browser-unique `eN` id backed by its CDP `backendDOMNodeId`, and stores `{tabId, backendNodeId, role, name, nth}` in the extension.
2. `click @e12` resolves the cached backendNodeId → `DOM.scrollIntoViewIfNeeded` → `DOM.getBoxModel` → trusted hover + press + release at the center (`Input.dispatchMouseEvent`, `pointerType: "mouse"`).
3. If the node was replaced by same-page DOM churn, the resolver re-finds it by role+name+nth in a fresh AX tree, **heals the map entry**, and proceeds.

**Tab safety:** the ref carries its tab. `click @e12` acts on the tab that produced e12, never the active tab — the user can keep browsing. A contradicting `--tab` is `target_conflict`.

**Interception:** before dispatching, the click point is hit-tested. If an unrelated element (overlay, sticky header, modal) owns it, the click fails with `click_intercepted` naming the interceptor — dismiss it or scroll, then retry. Inner text / wrapping labels pass; `fill`/`type` skip the check.

**Use when:** almost always. Covers buttons/links/inputs, named content, cursor-pointer div-soup, and shadow DOM (the AX tree pierces shadow roots; `querySelector` can't).

**Fails on:**
- Real navigation — refs die with the document (Chromium reuses backendNodeId integers in the new document, so acting on them would click ghosts). `stale_ref` → re-run `snapshot`.
- Sweep refs (`clickable` role) that lost their node — no AX presence to heal from. `stale_ref`.

**Failure mode:** `error.code = stale_ref` with the re-snapshot hint, or `target_conflict` for tab mismatches. Branch on the code.

### 2. CSS selector — `chrome-relay click '<selector>'`

```bash
chrome-relay click 'button[aria-label="Save"]' --tab 42
```

**Under the hood:** page-side `document.querySelector` → scroll into view → center → same trusted CDP mouse triple.

**Use when:** you know a stable selector statically and don't need a snapshot first.

**Fails on:** hash-rotated class names, shadow DOM (querySelector doesn't pierce), selectors you'd have to guess. **Failure mode:** `element_not_found` with the selector echoed back; malformed CSS is `invalid_arguments`.

### 3. Coordinate click — `chrome-relay click --x N --y N`

```bash
chrome-relay click --tab 42 --x 540 --y 320
```

**Under the hood:** CDP mouse triple at the given pixels. No DOM lookup, no scrolling.

**Use when:** the target isn't in the DOM at all — canvas UIs, SVG chart internals (anonymous `<path>` segments have no usable handle in any DOM-based strategy). Get coords from a `js` `getBoundingClientRect()` probe or a fresh screenshot.

**Fails on:** layout shifts between learning the coords and clicking. **Failure mode:** always returns `clicked: true` — the verb's contract is "fire a click at (x, y)," nothing more.

### 4. Free-form JS — `chrome-relay js '<code>'`

Unchanged: `Runtime.evaluate` in MAIN world for framework internals, scraping, custom searches. Remember `.click()` from JS is **synthetic** (`isTrusted: false`) — anti-bot pages reject it; use it to *find* things, then click via a trusted verb.

### Deprecated: `click-ax --node <id>`

Superseded by refs — `snapshot` refs are backendNodeIds with a friendlier handle, tab safety, and healing on top. `click-ax` remains for callers holding raw ids from `snapshot --json`; it does not heal. Will be removed.

## The difficulty matrix, by site profile

Measured 2026-06-11 (see `agent-browser-adoption-spec.md`, coverage evidence):

| Site profile | `click @ref` | `click <selector>` | `click --x/y` | `js` |
|---|---|---|---|---|
| Marketing pages, docs, plain forms | **best** | easy | overkill | overkill |
| Well-built React (Linear, Notion, **Cloudflare dash** — measured 0 div-soup) | **best** | classnames rotate | fragile | for internals |
| Tailwind div-soup SPAs (autark email rows — measured 37 cursor-pointer divs with no role) | **best** (sweep catches them) | ❌ nothing to select | works | works |
| Canvas UIs (Figma, Excalidraw), SVG chart internals | ❌ no DOM handle | ❌ | **only option** | to find coords |
| Shadow-DOM-heavy (web components) | **best** (AX pierces) | ❌ needs piercing | works | works |
| Anti-bot (`isTrusted` checks) | **best** (trusted events) | **best** | **best** | ❌ synthetic |

## Recipe: click by visible text

`chrome-relay` intentionally does NOT have a `click-text` verb. First try `snapshot -i` — the text you can see is almost always a node name you can grep in the snapshot, with a ref attached. When it genuinely isn't (text inside canvas, exotic rendering), compose `js` + `click --x/--y`:

```bash
COORDS=$(chrome-relay js --tab 42 "
  const target = 'chrome-relay.kushalsm.com';
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    if ((n.textContent || '').includes(target)) {
      const r = n.parentElement.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, found: true };
    }
  }
  return { found: false };
")
X=$(echo "$COORDS" | jq -r '.result.x // empty')
Y=$(echo "$COORDS" | jq -r '.result.y // empty')
if [ -n "$X" ] && [ -n "$Y" ]; then
  chrome-relay click --tab 42 --x "$X" --y "$Y"
fi
```

## Anti-patterns

### Don't retry a stale ref

`stale_ref` means the page changed under you. The fix is one `snapshot`, not a retry loop — the ref will never come back.

### Don't reach for `js` + `.click()` for clickable elements

Synthetic event (`isTrusted: false`), fails on anti-bot pages. Use `js` to find, trusted verbs to act.

### Don't reach for `--x/--y` without a fresh rect or screenshot

Coords drift the moment the page scrolls or resizes.

### Don't switch strategy in a loop hoping one works

Pick by site profile, fail loudly, read the error code. If you don't know which strategy fits, `snapshot -i` and look.

## Why we have so many verbs

Per [philosophy](./cli-philosophy.md) §1: each strategy has a different failure mode, and the agent's transcript should contain the diagnosis. A hypothetical "smart click" with auto-fallback would just report "click failed" with no knob to turn. The one piece of automatic behavior we do allow — the role/name heal inside ref resolution — reports itself (`healed: true` in the response) for exactly this reason.

## Status by version

| Verb | Available in |
|---|---|
| `click @ref` / `fill @ref` / `hover @ref` / `type --selector @ref` | **0.6.0+** |
| `snapshot` | **0.6.0+** |
| `click <selector>` | 0.2.x+ |
| `click --x N --y N` | 0.5.19+ |
| `click-ax --node <id>` | 0.3.x+, deprecated 0.6.0 |
| `read` / `ax` | deprecated 0.6.0 — aliases for `snapshot` |
| ~~`click-text`~~ | intentionally not shipped — see [recipe](#recipe-click-by-visible-text) |
