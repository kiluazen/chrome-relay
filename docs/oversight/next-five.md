# Next five chrome-relay features — design calls I need your eyes on

Three features shipped at `9c91d3c` (§2.8, §2.2, §2.3). This doc covers the next five and the open design calls inside each. Same format as `three-features-pass.md` — every section ends with **my proposed answer** and an explicit ask so you can annotate and move me.

Order is chosen to ship cheapest-first while still unlocking the bigger items in time:

1. **§2.7c Console capture** — smallest, ready, no design calls
2. **§2.1 Groups** — biggest unlock for autark parallelism, real lifecycle design call
3. **§2.4 A11y tree** — small spec gap (interactive-only filter), big agent value
4. **§2.7a Network capture** — real spec work (HAR + body buffering)
5. **§2.5 Smart resolver** — most strategic, depends on §2.4, needs a contract

After this set, the remaining boundaries.md items (§2.6 screencast, §2.7b cookies/storage write, §2.9 capture→replay) become the next round. I'm holding §2.6 because its perceptual-quality questions deserve their own thinking pass, and §2.7b is gated by the safety design.

I'm also flagging one **pre-flight cleanup** at the top — fixing the existing `cdp.ts` detach bug — because groups + a11y + network all attach the debugger and we'll multiply the bug's surface area if we don't fix it first.

---

## 0. Pre-flight — fix `cdp.ts` detach tracking (NOT a feature, but blocks the next 3)

**What's broken.** `apps/extension/src/browser/cdp.ts` keeps an in-memory `Set<number>` of "tabs we've attached the debugger to." The set decides whether to re-attach on the next `send()`. Problem: Chrome auto-detaches the debugger after ~30s of inactivity (or when the user opens DevTools manually), and we never hear about it because no `chrome.debugger.onDetach` listener is wired up. After auto-detach, the set still says "attached," our next `send()` skips re-attach, and the CDP call fails with `Cannot attach the same debugger to a target twice` or `Detached`.

**Why it matters now.** Groups (§2.1) attaches to multiple tabs. A11y tree (§2.4) attaches per-frame. Network capture (§2.7a) attaches and stays attached for the duration of the capture window. All three multiply the surface area where this races.

**Fix shape.** Wire `chrome.debugger.onDetach.addListener` once at module load, remove the tabId from the set on event. Add a small `isAttached(tabId)` predicate too so callers can branch defensively.

**No call needed** — this is a bug. I'll do it as part of starting §2.1.

---

## 1. §2.7c — Console capture (`chrome-relay console`)

The smallest of the five. No real design calls. Listed first because the cost-to-ship is ~30 minutes and it removes the biggest agent debugging gap.

**What it does.** Subscribe to `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded` for a tab. Buffer per-tab in the service worker (ring buffer, last N entries). CLI surface:

```sh
chrome-relay console --tab <id>            # dump last 200 entries
chrome-relay console --tab <id> --tail     # streaming (long-lived HTTP)
chrome-relay console --tab <id> --clear    # reset the buffer
chrome-relay console --tab <id> --level error,warn   # filter
```

**Where it lives.**
- Extension: new file `apps/extension/src/browser/console-buffer.ts` (ring buffer + listener wiring).
- Protocol: new `TOOL_NAMES.CONSOLE = "chrome_console"`.
- CLI: new `console` subcommand in `program.ts`.

**Open call #1 — `--tail` semantics.** I want to skip true streaming for now. `--tail` would print "polling every 500ms, last 200 entries, dedupe by entry id." That's almost-as-good and doesn't require a new long-lived HTTP path in the bridge. **Proposed:** ship without `--tail` in the first cut, add it if anyone asks. The non-tail dump covers 90% of "what just happened" debugging.

**Open call #2 — buffer size.** I'll default to 200 entries per tab, hard cap memory at ~256 KB per tab. Wipe on tab close. **Confirm or override.**

**Risk.** Tiny. Self-contained in the extension's service worker; no new CDP attach risks; the CDP commands here are read-only event subscriptions.

---

## 2. §2.1 — Groups (parallel autark hypotheses)

The big unlock. Today autark runs hypotheses sequentially because they fight over the same active tab. Groups gives every hypothesis its own Chrome window.

**Concept recap.** A "group" is a named handle for a Chrome window. Every existing tool gains an optional `--group <name>` flag; when present, "active tab" means "active tab *of that group's window*", not "any window."

**CLI surface.**
```sh
chrome-relay group create bidsmith-h01      # opens new window, prints groupId
chrome-relay group list                     # name, windowId, tabCount, foreground
chrome-relay --group bidsmith-h01 navigate "https://reddit.com"
chrome-relay --group bidsmith-h01 screenshot -o ev.png
chrome-relay group close bidsmith-h01
```

**Open call #1 — Hard vs Soft lifecycle. This is the call I most want your read on.**

A Chrome window the user can close at any time is a shaky primitive for "a group." Two patterns:

- **Hard.** Group is owned by chrome-relay. We store `{ name, windowId }` in `chrome.storage.local`. If the user manually closes the window, the group is orphaned — every subsequent `--group X` op fails loudly with "group X's window is gone; run `group close X` to clean up, or `group create X` to re-open." Simple invariant: a group's name always points at exactly one specific window we created.
- **Soft.** Group is a name attached to whatever window currently holds the group's original tab. If the user closes the window, the next `--group X navigate <url>` recreates the window and reattaches the name. More forgiving but the user can't tell which window is "their" group at a glance.

**My proposed answer: Hard.** Reasoning: agents need predictable failure modes more than they need forgiveness. "Window gone, fix it loudly" is easier to handle in a prompt than "secretly recreated, you've lost your tab state." Also Hard is ~30 LOC simpler.

**Override candidate** if you'd rather the agent never see a hard error and we trade clarity for resilience.

**Open call #2 — `--group` semantics when the group's window has multiple tabs.** A group is a window; the user might open extra tabs in that window. When the agent runs `chrome-relay --group X read` without `--tab`, which tab does it target?

Three options:
- **a) "active tab of group's window"** — matches normal chrome-relay default behavior, just scoped. Easy to reason about.
- **b) "last tab created by --group X"** — tracks per-group the most-recently-opened tab. Stickier but means we maintain extra state.
- **c) Error if multiple tabs and no `--tab`** — forces the agent to be explicit. Safest but more friction.

**My proposed answer: (a)**. It mirrors the no-group default — "active tab" — and the agent can always pass `--tab` to be specific. Less state to maintain in the extension.

**Override candidate** if you've felt the pain of "agent typed into the wrong tab in the same window" before and want (c) for safety.

**Open call #3 — Should `--group` work on every tool or only on tab-creating tools?**

`chrome-relay click --tab 123` is unambiguous — the agent knows the tabId. Passing `--group X --tab 123` is redundant; the group flag is moot once `--tab` is specified. Two options:

- **a) `--group` works on every tool**; if `--tab` is also passed, `--group` is ignored (no-op). Documented as "tab wins."
- **b) `--group` only on tools that resolve "active tab"** (i.e. tools that accept no `--tab` and default to active). Rejected with a clear error on tools where `--tab` is required.

**My proposed answer: (a)**. Costs nothing, lets the agent build `--group X` into a wrapper alias without worrying which tools care. The doc explains "tab wins" once and we're done.

**Open call #4 — Cross-group race conditions.** Today our `attached: Set<number>` per-tab serializer already handles parallel ops on different tabs. Two agents on different groups doing `screenshot` in parallel will both go through `chrome_screenshot` → `getTargetTab` → `Page.captureScreenshot`. The screenshot CDP doesn't activate the tab (we capture beyondViewport), so there's no global activation race. **I think we're already safe.** No code needed, but I want to flag it because the boundaries.md author worried about it and I want to confirm I'm right that it's already a non-issue.

**Risk.** Medium. Lifecycle edge cases will bite as users actually use this; the Hard model has known sharp edges (loud failures on window close) that need decent error messages.

---

## 3. §2.4 — A11y tree (`chrome-relay ax`)

30× smaller and far more semantic than the DOM snapshot. The single biggest token-efficiency win for agents.

**What it does.** Pulls Chrome's accessibility tree via CDP `Accessibility.getFullAXTree` / `getPartialAXTree`. Returns a compact JSON with one node per a11y-relevant element: `{ id, role, name, value, state, children }`.

**CLI surface.**
```sh
chrome-relay ax --tab <id>                              # full tree, JSON
chrome-relay ax --tab <id> --interactive-only           # filter to actionable
chrome-relay ax --tab <id> --root "main"                # subtree under a role
chrome-relay click-ax --tab <id> --node <ax-id>         # click by AX id
```

**Open call #1 — what counts as "interactive" for `--interactive-only`?** boundaries.md flagged this gap. I propose this fixed list (ARIA spec's `widget` role family + native form controls):

```
button, link, checkbox, radio, textbox, combobox, listbox, option,
menuitem, menuitemcheckbox, menuitemradio, slider, spinbutton, switch,
tab, treeitem, searchbox
```

Anything else (heading, paragraph, region, navigation, etc.) drops out under `--interactive-only`. **Confirm the list or add/remove specific roles.**

**Open call #2 — cross-frame AX traversal.** `Accessibility.getFullAXTree` takes a `frameId` parameter. Multi-frame pages (Stripe Checkout, Substack embeds) need us to walk subframes too. Two options:

- **a) By default, only the top frame.** Caller adds `--include-subframes` if they need more. Smaller payload, fewer surprises.
- **b) By default, walk all same-origin subframes.** Wider coverage but bigger payload and cross-origin frames are still excluded.

**My proposed answer: (a)** — default to top-frame-only, add a flag for subframes. Same-origin walk is a sharp edge I'd rather opt into than out of.

**Open call #3 — `click-ax` lifecycle.** AX node ids are stable within a `getFullAXTree` snapshot but can drift if the page mutates between the `ax` call and the `click-ax` call. Two options:

- **a) Caller's responsibility.** `click-ax` calls `getAXNodeAndAncestors` to resolve; if the node is gone, throws "AX node N no longer exists; re-run `chrome-relay ax --tab <id>`."
- **b) Auto-retry.** `click-ax` resolves; if gone, automatically re-pulls the AX tree, finds the node by role+name, retries once.

**My proposed answer: (a)** — explicit failure beats silent magic for an agent's prompt loop. The agent can decide to re-pull or pivot. (b) hides drift and makes the failure mode harder to diagnose.

**Risk.** Low for the read-side `ax` tool; medium for `click-ax` if AX node staleness turns out to bite often. We'll learn that from usage.

---

## 4. §2.7a — Network capture (`chrome-relay network`)

The single largest agent-debugging upgrade. Includes HAR export.

**What it does.** Subscribe to `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `loadingFailed`. Buffer per-tab. On demand, emit a HAR (HTTP Archive) file — a universal "I have a network log, replay this" format.

**CLI surface.**
```sh
chrome-relay network --tab <id>                    # last 50 requests, headers + timings
chrome-relay network --tab <id> --tail             # live stream
chrome-relay network --tab <id> --filter graphql   # url substring filter
chrome-relay network --tab <id> --body <reqId>     # body for one request (opt-in)
chrome-relay network har --tab <id>                # full HAR file
```

**Open call #1 — body buffering.** Request and response bodies aren't streamed in `Network.*` events; they're available on demand via `Network.getResponseBody { requestId }` — but only while the request is still "alive" in Chrome's memory. After ~30 seconds or so Chrome may GC the body. Two options:

- **a) Eager: buffer every response body up to N KB.** Memory cost, but `--body <reqId>` always works for recent requests.
- **b) Lazy: never buffer; `--body <reqId>` calls `getResponseBody` on demand and may fail with "body no longer available."**

**My proposed answer: (b) lazy, with a documented limit.** Eager buffering of N KB × 50 requests could chew through 50 MB easily on a media-heavy page. Lazy with a "body not available" error is honest. The agent learns to call `--body` right after seeing the request, not 10 minutes later.

**Open call #2 — HAR format completeness.** HAR is a spec, not a toy. Things we'd need to fill in correctly: `pages`, `entries`, per-entry `request` / `response` / `timings` / `cache`, request post-data, response content, cookies. Tools like Charles / Wireshark / Postman ingest HAR strictly; a hand-rolled half-HAR will mostly work but quietly break corners.

**My proposed answer: ship a "HAR-compatible" subset that covers `entries[].{request, response, timings}` (the parts every consumer cares about) and explicitly leaves `pages`, `creator`, `comment` empty.** Document the subset in `--help` so callers know what's omitted. Iterate if a real tool we want to feed (Postman, Insomnia) chokes on the omissions.

**Override candidate** if you want strict-HAR from day one. That's another ~150 LOC of fiddly spec compliance.

**Open call #3 — WebSocket / SSE / fetch streams.** These don't fit `request → response` cleanly. Separate CDP events (`Network.webSocketFrameReceived`, etc.). Two options:

- **a) Out of scope for v1.** Capture HTTP only. WebSocket frames just don't appear in `chrome-relay network`. Documented limitation.
- **b) Include WebSocket as a separate channel** — `chrome-relay network --tab <id> --ws-only` lists frames.

**My proposed answer: (a)** — out of scope for the first cut. The agents using autark today are pulling REST endpoints; WebSocket comes later when there's a real ask.

**Risk.** Higher than the others. Network capture inherently touches privacy (auth tokens in headers, body contents) — we need a paragraph in the privacy policy and a clear "this captures network traffic for the current tab" warning when first invoked.

---

## 5. §2.5 — Smart resolver (`chrome-relay find` / `click-find`)

The most strategic and most spec-heavy. Depends on §2.4 (a11y tree) being shipped first.

**What it does.** Caller asks for an element by natural-language description. Extension fetches the AX tree, hands it + the description to a small model, gets back the AX node id, optionally clicks. The big agent never sees the AX tree — just the answer.

**CLI surface.**
```sh
chrome-relay find "the blue Save button" --tab <id>
chrome-relay click-find "the blue Save button" --tab <id>
```

**Open call #1 — where does the small model run? (the boundaries.md author's question, kicked to me.)**

Three options:
- **a) Local.** Ship a tiny model (Phi-3 mini, Qwen 2.5 1.5B) via `node-llama-cpp` or `ollama`. Pros: no API key, no cost, no telemetry. Cons: ~2GB install footprint, cold-start latency.
- **b) Remote.** Use Anthropic Haiku / OpenAI 4o-mini via the user's own key (from `~/.autark/credentials.json` or a chrome-relay-specific env var). Pros: zero install, instant. Cons: needs key, adds a roundtrip.
- **c) Agent-provided.** Caller passes `--resolver-endpoint <url>` (or env var); chrome-relay POSTs the AX tree + description there. Pros: caller controls cost + model choice. Cons: agent harness has to provide it.

**My proposed answer: (c) with (b) fallback.** chrome-relay stays model-agnostic by default — matches its "any agent" positioning. Fallback to Haiku via a `CHROME_RELAY_RESOLVER_API_KEY` env var so casual users can play with `find` without standing up an endpoint. **Confirm.**

**Open call #2 — the resolver endpoint contract.** If we pick (c), we need a precise POST shape. Proposed:

```
POST <resolver_endpoint>
Content-Type: application/json

Request:
{
  "description": "the blue Save button",
  "ax_tree": [ ... compact AX nodes ... ],
  "model_hint": "haiku" | "fast" | null
}

Response:
{
  "node_id": "ax_42",
  "confidence": 0.94,
  "reasoning": "..." (optional)
}
```

If confidence < 0.7 we throw `LowConfidenceMatch` rather than blindly clicking. **Confirm the shape — especially: do we want the resolver to be able to return a *list* of candidates instead of one, so the caller can pick?**

**Open call #3 — low-confidence behavior.**

- **a) Throw `LowConfidenceMatch` with the top 3 candidates.** Caller decides what to do.
- **b) Auto-pick the top match anyway, attach `confidence: 0.5` so the caller can decide whether to trust it.**

**My proposed answer: (a)** — silent low-confidence picks lead to "agent clicked the wrong button" with no breadcrumb. Loud is better.

**Risk.** Highest of the five. The resolver loop crosses chrome-relay's traditional "no LLM inside the tool" boundary. We need a clean failure mode when there's no resolver configured (just throw "find requires a resolver endpoint, see docs").

---

## Sequencing summary

For your sequencing eyes, here's how I'd actually execute through these:

1. **Pre-flight cdp.ts detach fix** (~30 min, no design)
2. **§2.7c console** (~30 min) — fully ready, ships independently
3. **§2.1 groups** (~3 hours) — biggest unlock; lifecycle call needs your read first
4. **§2.4 a11y tree** (~3 hours) — interactive-only filter list call needs confirmation
5. **§2.7a network** (~5 hours including HAR subset spec) — privacy paragraph needed
6. **§2.5 smart resolver** (~3 hours) — depends on §2.4 shipping first; resolver-endpoint contract needs your read

Total if you confirm all my proposed answers: roughly two solid days of focused work to land all five plus the pre-flight fix.

**Annotate any of the 12 design calls** (#1 + 2×#2 + 4×#3 + 3×#4 + 3×#5) and I'll execute against your annotations. Anything you don't annotate = my proposed answer wins.
