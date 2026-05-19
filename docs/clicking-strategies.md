# Click strategies — how chrome-relay clicks things

There is no single "click" because there is no single way to identify an element across the web. Each strategy below is a separate verb in chrome-relay's CLI. Per [the CLI philosophy](./cli-philosophy.md): we expose verbs, the agent picks the right one for the site profile.

## TL;DR — pick by what you have

| Agent has | Verb |
|---|---|
| A CSS selector | `chrome-relay click '<selector>'` |
| A backendDOMNodeId from `ax` | `chrome-relay click-ax --node <id>` |
| Pixel coordinates | `chrome-relay click --x N --y N` |
| Visible text on the page (no selector, no rect) | `js` + `click --x/y` (see [recipe](#recipe-click-by-visible-text)) |
| Anything weird (shadow DOM, canvas, framework internals) | `chrome-relay js "<code>"` |

## Each strategy in depth

### 1. CSS selector — `chrome-relay click '<selector>'`

```bash
chrome-relay click 'button[aria-label="Save"]' --tab 42
chrome-relay click '.modal .primary' --tab 42
```

**Under the hood:**
1. Page-side JS runs `document.querySelector(selector)`.
2. `element.scrollIntoViewIfNeeded()` so it's actually in viewport.
3. `getBoundingClientRect()` gives the center.
4. CDP `Input.dispatchMouseEvent` fires hover + press + release at those coords.

The mouse events are **trusted** — they pass the `isTrusted: true` check that React's synthetic events and most anti-bot heuristics gate on. This is the difference between "looks clicked" and "the target site actually accepts the interaction."

**Use when:** stable selectors exist, page is well-structured.

**Fails on:**
- Sites with hash-rotated class names (`._3a8K9d` from CSS modules).
- Shadow DOM (querySelector doesn't pierce shadow roots by default).
- Sites where the agent doesn't know the selector ahead of time.
- Cards rendered without semantic markup (Cloudflare dashboard cards — the visible text is in an `<H3>` but the click target is an unmarked wrapping `<div>`).

**Failure mode:** `element_not_found` with the selector echoed back. Clear and actionable.

### 2. Accessibility tree — `chrome-relay click-ax --node <id>`

```bash
chrome-relay ax --tab 42 -i        # returns tree of {role, name, id}
chrome-relay click-ax --node 4837 --tab 42
```

**Under the hood:**
1. Agent first calls `chrome-relay ax` and gets a semantic tree: `{role: "button", name: "Sign in", id: 4837, ...}`.
2. Agent picks a node by its semantic name.
3. `click-ax` resolves the backendDOMNodeId back to a live DOM node via CDP `DOM.resolveNode`, gets its rect, clicks via `Input.dispatchMouseEvent`.

The `id` is selector-resilient — it doesn't change when CSS classes get rehashed, doesn't break when the page re-renders, doesn't depend on the agent guessing right.

**Use when:** the page has proper `role` and `aria-label` markup. Most well-built React apps (Linear, Notion editor surface) qualify.

**Fails on:**
- Pages whose authors didn't bother with accessibility roles (Cloudflare dashboard — exact case from today's session).
- The two-call overhead (read tree, then click) costs round-trips.
- Stale ids: if the page mutates between `ax` and `click-ax`, the node may have moved.

**Failure mode:** `element_not_found` for stale ids, with a hint to re-run `ax`.

### 3. Coordinate click — `chrome-relay click --x N --y N`

```bash
chrome-relay click --tab 42 --x 540 --y 320
chrome-relay click '<selector>' --tab 42        # same command, selector OR coords
```

**Under the hood:**
1. CDP `Input.dispatchMouseEvent` fires hover + press + release at the given pixel coords.
2. No DOM lookup. No scrolling. Just events at coords.

**Coordinate source:** the agent's own knowledge. Could be from a screenshot they read, from a `getBoundingClientRect()` they called via `js`, from hardcoded screen positions in a test fixture.

**Use when:**
- The element isn't in the DOM (canvas).
- The DOM is hostile (CF cards) and the agent already has the rect from a previous read.
- Reproducing a recorded interaction.

**Fails on:**
- Layout has shifted since the agent learned the coords. (Mitigation: take a fresh screenshot first, or read the rect via `js` and click immediately after.)
- Coords are outside the viewport. (Page won't scroll automatically — agent must scroll first via `js`.)

**Failure mode:** Always returns `clicked: true` (CDP dispatched the event). Whether the event hit something useful is the page's problem. This is intentional — the verb's contract is "fire a click at coords (x, y)," nothing more.

### 4. Free-form JS — `chrome-relay js '<code>'`

```bash
chrome-relay js --tab 42 "
  const card = [...document.querySelectorAll('div')]
    .find(d => d.innerText.includes('chrome-relay.kushalsm.com'));
  card?.click();
  return !!card;
"
```

**Under the hood:** `Runtime.evaluate` in the page's MAIN world. Agent writes whatever JS they want.

**Use when:**
- Shadow DOM piercing.
- Same-origin iframe traversal.
- Framework-internal pokes (Lexical editor state, React refs, Zustand stores).
- One-off scraping where you want a custom search.

**The tradeoff:** `element.click()` from JS is a **synthetic** event (`isTrusted: false`). Many React handlers don't care, but some anti-bot setups and some sites that gate on trusted events (login flows, payment forms) reject it. If `js` clicks but nothing happens downstream, switch to one of the trusted-event verbs above.

**Failure mode:** `js` returns whatever the code returned, or `cdp_error` if the eval threw. No element-finding logic in chrome-relay — the agent owns it.

## The difficulty matrix, by site profile

| Site profile | `click` (selector) | `click-ax` | text-recipe | `click --x/y` | `js` |
|---|---|---|---|---|---|
| Marketing pages, docs sites | easy | easy | easy | overkill | overkill |
| Plain forms (most signup pages) | easy | easy | easy | overkill | overkill |
| Well-built React (Linear, Notion editor) | classnames may rotate | **best** | works | fragile to layout | for internals |
| Material-UI / Tailwind sites with semantic markup | easy | easy | easy | overkill | overkill |
| Cloudflare dashboard, Vercel dashboard | ❌ wrapped in unmarked divs | ❌ no role=link | **best** | works from screenshot | works |
| Canvas-based UIs (Figma, Excalidraw) | ❌ no DOM | ❌ no semantic tree | ❌ no text node | **only option** | ❌ |
| Shadow-DOM-heavy (Stencil, web components) | needs piercing | partial | **works** (TreeWalker pierces) | works | works |
| Pages with anti-bot (`isTrusted` checks) | **best** (trusted events) | **best** | **best** | **best** | ❌ synthetic events |

## Recipe: click by visible text

`chrome-relay` intentionally does NOT have a `click-text` verb — it's
composable from `js` + `click --x/--y`, and a one-call wrapper would just
be a smart wrapper hiding which strategy ran (see [philosophy](./cli-philosophy.md)).

The two-call pattern:

```bash
# 1. Find the text in the page DOM (TreeWalker covers shadow roots too)
#    and return the center of its parent element's bounding rect.
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

# 2. Parse out x/y, click via coords. Same trusted Input.dispatchMouseEvent
#    a selector-click would use — anti-bot heuristics don't differentiate.
X=$(echo "$COORDS" | jq -r '.result.x // empty')
Y=$(echo "$COORDS" | jq -r '.result.y // empty')
if [ -n "$X" ] && [ -n "$Y" ]; then
  chrome-relay click --tab 42 --x "$X" --y "$Y"
fi
```

For multiple matches, the `js` call can be parameterized to pick the nth occurrence, or to restrict to a specific ancestor (e.g. only within `.dashboard-content`). Strategy stays in the agent's hands; chrome-relay is the dumb pipe.

## Anti-patterns

### Don't reach for `js` + `.click()` for clickable elements

```bash
# ❌ wrong — synthetic event (isTrusted: false), fails on anti-bot pages
chrome-relay js --tab 42 "
  const el = [...document.querySelectorAll('*')].find(e => e.textContent.includes('Save'));
  el?.click();
"

# ✅ right — trusted event via the recipe above (js to find coords, then click --x/--y)
```

### Don't reach for `--x/--y` without taking a fresh screenshot or rect

Coords drift the moment the page scrolls or resizes. If you can't take a fresh screenshot right before clicking, prefer a DOM-based strategy.

### Don't expect `js`'s `.click()` to behave like a real click

JS `.click()` fires a synthetic MouseEvent. It works on most sites but fails silently on anti-bot pages and some hand-rolled event delegation. The trusted-event verbs (`click` in either form, `click-ax`) all use `Input.dispatchMouseEvent` and pass `isTrusted: true`.

### Don't switch strategy in a loop hoping one works

```bash
# ❌ wrong — agent burns 5 round-trips and ends up clicking something else
for strategy in selector ax text coords; do
  chrome-relay click-$strategy ... && break
done

# ✅ right — pick the strategy that fits the site profile, fail loudly if it doesn't
```

If you don't know which strategy fits, take a screenshot, read the page with `chrome-relay read -i` or `chrome-relay ax`, then pick deliberately.

## Why we have so many verbs

Per [philosophy](./cli-philosophy.md) §1: we expose precise primitives because each strategy has a different failure mode. An agent that ran `click --x/--y` after a `js` TreeWalker knows the click target came from text search and can sanity-check by reading the rect back. An agent that ran a hypothetical "smart click" with auto-fallback would just see "click failed" and not know which knob to turn.

The cost is more CLI surface. The benefit is that when something goes wrong, the agent's transcript already contains the diagnosis.

## Status by version

| Verb | Available in |
|---|---|
| `click <selector>` | 0.2.x+ |
| `click --x N --y N` | **0.5.19+** |
| `click-ax --node <id>` | 0.3.x+ |
| `js <code>` | 0.2.x+ |
| `hover` (selector, x/y, or both) | 0.5.0+ |
| ~~`click-text`~~ | intentionally not shipped — see [recipe](#recipe-click-by-visible-text) |
