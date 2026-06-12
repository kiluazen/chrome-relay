# Refs

> @eN handles that carry their own tab, heal across DOM churn, and refuse to click through overlays.


Every actionable element in a [snapshot](/docs/snapshots/) gets a ref — `@e12` — and every element-addressed command accepts one:

```sh
chrome-relay click @e12
chrome-relay fill @e14 "value"
chrome-relay hover @e3
chrome-relay type "text" -s @e7
```

A ref is not a CSS selector and not a coordinate. Under the hood it's the element's Chrome-internal node id (`backendDOMNodeId`) plus enough semantics (`role`, `name`, position-among-twins) to find the element again if the id goes stale.

## Refs carry their own tab

This is the rule that makes refs safe in a browser a *human* is also using. `click @e12` acts on the tab that produced `e12` — never "the active tab", which is whatever you happen to be reading right now. Concretely:

- No `--tab` needed on ref actions.
- Ref numbers are unique across the whole browser (the counter never resets), so `@e12` can't mean two things.
- A contradicting `--tab` is an error, not a guess:

```json
{ "relayError": { "code": "target_conflict",
  "message": "@e16 belongs to tab 460154464 but --tab 99999 was passed. Refs carry their own tab — drop --tab or use a ref from that tab's snapshot." } }
```

## Lifetime: churn heals, navigation kills

**Same-page DOM churn: refs survive.** Pages re-render constantly — a toast appears, a list reorders, React swaps a subtree. The resolver tries the cached node id first (one CDP call verifies it's live), and if the node was replaced, re-finds it by role + name + position and *heals* the ref in place. Healed actions report it:

```json
{ "clicked": true, "ref": "e16", "healed": true }
```

**Real navigation: refs die, on purpose.** Chrome reuses node-id integers in a new document — a ref from the old page could silently resolve to an unrelated element on the new one. (We caught this live: a stale ref "successfully" clicked a random link on the page that replaced it.) So navigation invalidates the tab's refs, and acting on one fails loud:

```json
{ "relayError": { "code": "stale_ref",
  "message": "@e19 is not a known ref (no snapshot produced it, or its tab was re-snapshotted). Re-run `chrome-relay snapshot` and use a fresh ref." } }
```

SPA route changes (pushState — the document persists) keep refs alive; the heal step covers the re-render.

The agent rule is one line: **`stale_ref` → snapshot again.** Never retry the same ref; it isn't coming back.

## Interception: no clicking through overlays

Before dispatching, a ref click hit-tests its target point. If an unrelated element owns it — a modal, cookie banner, sticky header — the click is refused, naming the interceptor:

```json
{ "relayError": { "code": "click_intercepted",
  "message": "@e8 resolved, but an unrelated <div> owns the click point (412, 96) — an overlay, sticky header, or modal is covering it. Dismiss it or scroll, then retry.",
  "details": { "interceptor": { "nodeName": "DIV", "backendNodeId": 1042 } } } }
```

Without this check, the click "succeeds", the overlay eats it, and the agent's next snapshot makes no sense. The check allows same-lineage hits (a button's inner text, a label wrapping its input) and is best-effort — if the hit-test itself can't run, the click proceeds rather than false-positive.

`fill` and `type` skip the check deliberately: they write via the node, not the pointer, and writing into a visually covered input is legitimate.

## Service-worker restarts

Chrome kills idle extension service workers whenever it likes. The ref map persists across restarts (and is re-verified through CDP before any action — persistence restores ids, not trust), so an agent's refs don't vanish mid-task because Chrome got tidy.

## When refs aren't the tool

Refs cover the DOM. Two things aren't in the DOM in any useful way:

- **Canvas internals** (Figma-style UIs) — nothing to reference.
- **SVG chart segments** — anonymous `<path>` elements; no role, no name, no sane selector either.

For those, get coordinates from a `js` probe or a screenshot and use `click --x N --y N`. The full decision tree is in [Clicking strategies](/docs/clicking/).
