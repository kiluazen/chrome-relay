# Spec: loop-ergonomics changes for chrome-relay (inspired by agent-browser)

Status: proposal for review. 2026-06-11.
Background: `docs/vs-agent-browser.md` (measurements + positioning). agent-browser source is cloned at `solo/agent-browser` — file refs below point into it so claims can be checked.

The thesis: chrome-relay's moat (real Chrome, real auth, no focus theft) is intact. What loses head-to-heads is loop ergonomics — output size, a broken ref loop, and missing wait/diff primitives. Everything below targets that. Nothing touches the transport chain (CLI → HTTP → native host → extension → CDP); these are all command-surface and handler changes.

Measured baseline (HN front page, same machine): agent-browser `snapshot -i` = 13.5 KB plain text; chrome-relay `read -i` = 61 KB JSON, `ax` full = 337 KB. Click round-trip: theirs `click @e110` (37ms), ours requires echoing a 100-char nth-of-type selector (160ms).

---

## Change 1 — One `snapshot` command, compact text by default

Replaces both `read` and `ax` (kept as deprecated aliases for one release, printing a `deprecated` notice).

### CLI surface

```
chrome-relay snapshot [--tab <id>] [-i|--interactive] [-c|--compact] [-d <n>] [-s <css>] [-u|--urls] [--diff] [--json]
```

### Output format (default, text)

One line per node, indented to tree depth:

```
Page: Hacker News
URL: https://news.ycombinator.com/

- link "Hacker News" [ref=e2]
- link "new" [ref=e3]
- cell "1." [ref=e10]
  - link "Lines of Code Got a Better Publicist" [ref=e11]
- textbox [ref=e41]: kushal@example.com
- checkbox "Remember me" [ref=e42, checked]
```

Grammar per node: `- {role} {"name"?} [{attrs}]{: value?}`. Attrs bracket carries, in order: `level=N`, `checked=true|false|mixed`, `expanded=`, `selected`, `disabled`, `required`, `ref=eN`, and (with `-u`) `url=`. Value renders as `: text` suffix only when it differs from name. This is agent-browser's exact render scheme (`agent-browser/cli/src/native/snapshot.rs:1060-1188`) — it's proven, don't innovate on it.

`--json` returns the structured envelope instead: `{ ok, data: { title, url, text, refs: { e3: { role, name, backendNodeId } } } }`. Bounds and CSS selectors are gone from default output entirely; they were ~300 bytes/element of payload the agent never used once refs are actionable.

### Tree source

CDP `Accessibility.getFullAXTree` (we already do this in `ax`), plus a single-pass in-page JS sweep for cursor-interactive elements the AX tree misses (`cursor:pointer`, `onclick`, `tabindex`, `contenteditable`) — agent-browser does this as one `querySelectorAll('*')` evaluation that tags matches with a temp attribute, batch-resolves backendNodeIds, then cleans up (`snapshot.rs:609-892`). Consecutive StaticText nodes merge; ignored/InlineTextBox nodes drop (`snapshot.rs:979-1027`).

Ref-bearing nodes: interactive roles always; content roles (heading, cell, listitem…) only when named; cursor-interactive extras. `-i` prints only ref-bearing lines. `-d N` truncates depth. `-s <css>` scopes via `DOM.querySelectorAll` → backendNodeId set. Role lists to copy verbatim: `snapshot.rs:11-66`.

### Where it runs

Extension handler builds the tree and assigns refs (it must — the ref map lives there, see Change 2); returns structured JSON over the wire. The **CLI renders the text**. Wire bytes don't cost tokens; only stdout does.

### Coverage evidence (measured 2026-06-11, logged-in real Chrome)

Swept three complex pages for visible clickables, split by what can capture them:

| page | native/role elements (AX gets) | cursor-pointer div-soup (only the JS sweep gets) | clickable SVG chart parts (nothing DOM-based gets) | canvas / cross-origin iframes |
|---|---|---|---|---|
| dash.cloudflare.com home | 125 | **0** | 74 | 0 / 0 |
| dash.cloudflare.com web-analytics | 160 | **0** | 102 | 0 / 0 |
| autark.sh app | 18 | **37** | 18 | 0 / 0 |

Takeaways: (1) Cloudflare's dash is semantically clean — pure AX-interactive captures 100% of its DOM clickables; the old "Cloudflare needs coordinate clicks" lore is about charts, not div-soup. (2) Div-soup is real on Tailwind-style SPAs (autark's own email rows are cursor-pointer spans/divs) — **the cursor-interactive sweep is therefore not optional**; without it, `-i` filtering silently hides real targets. (3) SVG chart internals are anonymous `<path>` elements with no aria — invisible to AX *and* useless via CSS selectors; they were always and remain screenshot + `--x/--y` territory (agent-browser has the identical gap). Refs must never be the only door: the fallback ladder in the skill doc is snapshot → `get`/`js` probe → screenshot + coordinate click.

### Acceptance

- `snapshot -i` on the HN front page ≤ 16 KB (parity ±20% with agent-browser's 13.5 KB).
- Every ref printed is immediately usable by Change 2 commands.
- `snapshot -i` on the autark.sh app includes the cursor-interactive non-native clickables found by the sweep (~37 raw, deduped to topmost targets) — this page is the div-soup regression test.
- `read`/`ax` still work, tagged deprecated.

---

## Change 2 — Refs are actionable everywhere

The core fix. Today `read` prints `ref_N` that no command accepts.

### CLI surface

```
chrome-relay click @e3            # also: fill @e5 "text", hover @e2, type --ref @e4, click --new-tab @e7
```

`@`-prefix is mandatory for refs — it keeps selector parsing unambiguous (a bare `e3` is a valid CSS type selector). Existing CSS-selector and `--x/--y` modes stay untouched.

### State

Extension service worker keeps one **global** ref map: `{ counter, refs: Map<eN, {tabId, backendNodeId, role, name, nth}>, lastSnapshotText: Map<tabId, string> }`. The counter is global and monotonic — ref numbers are never reused across tabs, so every `eN` is unique browser-wide and **carries its tab identity in the map**. A snapshot of tab A invalidates only tab A's previous refs.

Why global, not per-tab: chrome-relay's no-target default is "active tab in current window" (`apps/extension/src/browser/handlers/target.ts:31`), and the active tab is whatever the *user* is looking at — it changes under the agent constantly (that's the whole product). A bare `click @e3` resolved against the active tab would click inside whatever page the user happens to be reading. With tab-carrying refs:

- `click @e3` resolves to the tab that produced `e3`. No `--tab` needed, no active-tab guessing.
- `click --tab 99 @e3` where `e3` belongs to tab 42 → `target_conflict` error, not a wrong-tab click.
- Refs from a snapshot taken before an unrelated tab's snapshot stay valid (per-tab invalidation only).

Persist to `chrome.storage.session` so an MV3 service-worker restart doesn't orphan refs mid-session; drop a tab's entries on tab close.

**Frames: top-frame only in this PR.** Our CDP helper routes by tabId alone (`apps/extension/src/browser/cdp.ts:175` — `chrome.debugger.sendCommand({tabId}, ...)`, no sessionId); same-process iframes appear in the tab's AX tree and work for free, but OOPIFs (cross-origin iframes) need flattened session routing we don't have. No `frameId` in the ref entry yet — add it when OOPIF routing lands (follow-up: `chrome.debugger` sessionId targeting). agent-browser does have explicit frame/session resolution (`element.rs:311`, `resolve_frame_session`); we accept the gap and say so in the skill doc.

### Resolution path (per action)

1. Fast path: cached `backendNodeId` → `DOM.scrollIntoViewIfNeeded` → `DOM.getBoxModel` → click center via existing `Input.dispatchMouseEvent` triple.
2. Stale path: if the node is gone, re-query the AX tree and re-find by `role + name + nth` (agent-browser's fallback, `element.rs:299-396`). If found, **heal the map entry** (write the fresh backendNodeId back) and proceed; if not, return `error.code = stale_ref` (new code) with the hint `re-run snapshot`. Healing is *our addition*, not copied behavior: agent-browser's `resolve_element_center` takes `&RefMap` immutably and only returns fresh coordinates — a healed lookup there is recomputed from scratch on every subsequent action.
3. Interception check: hit-test the click point; if a different element owns it, fail with details rather than clicking through an overlay (`element.rs:369-377`).

Honest competitive framing (corrected after review): agent-browser's refs are **not** merely positional — `RefEntry` stores `backend_node_id, role, name, nth, frame_id` (`element.rs:9-16`) and resolution already does backendNodeId-fast-path → role/name/nth-fallback, same shape as ours. On resolution strategy we reach parity, not victory. What remains genuinely ours: (a) map healing (above), (b) tab-carrying refs (their refs are session-scoped to one browser they own; ours survive a user-controlled multi-tab browser), (c) `snapshot --diff` (Change 4). The staleness pain is still real on their side — their docs tell agents to re-snapshot after every change and issue #1351 measured +65% LLM calls — but the fix is turn-count economics (diff + healing), not a smarter ref struct.

### Acceptance

- snapshot → `click @eN` → done, no selector ever printed or echoed, **no `--tab` needed** — the ref resolves to the tab that produced it even when the user has since focused a different tab.
- `click --tab X @eN` with a ref belonging to tab Y returns `target_conflict`.
- A ref clicked after an unrelated DOM mutation (e.g. a toast appearing) still resolves via fast path.
- A genuinely dead ref returns `stale_ref`, not `internal_error`.

---

## Change 3 — `wait`

```
chrome-relay wait <css|@ref>                 # element exists and visible
chrome-relay wait --text "Welcome"           # body innerText contains
chrome-relay wait --url "**/dashboard"       # URL glob
chrome-relay wait --load networkidle|load|domcontentloaded
chrome-relay wait --fn "js expression"       # truthy
chrome-relay wait 1500                       # ms
```

All take `--timeout <ms>` (default 10000). Implementation in the extension handler: selector/text/fn poll `Runtime.evaluate` at 100ms; `--load` uses `Page.setLifecycleEventsEnabled` + lifecycle events; `--url` listens to navigation events. (agent-browser equivalents: `actions.rs:5597-5653`.) One HTTP call blocks until resolved — note the existing 30s tool-call timeout bounds the max; the handler must cap `--timeout` below it or the request must extend its own deadline.

On timeout: `error.code = timeout`, plus the *current* state in details (current URL / whether selector exists hidden) so the agent doesn't need a follow-up probe.

---

## Change 4 — `snapshot --diff`

Returns only what changed since the previous snapshot of that tab:

```
- - link "log in" [ref=e12]
- + link "kiluazen" [ref=e12]
- + link "logout" [ref=e13]
2 additions, 1 removal, 187 unchanged
```

Implementation: the extension already stores `lastSnapshotText` per tab (Change 2 state). Handler returns `{ text, prevText }`; the CLI line-diffs (Myers, any small npm diff lib) and prints unified output with 3 lines of context — agent-browser does exactly this with the `similar` crate (`diff.rs:103-148`). Identical strings short-circuit to `no changes`.

A full snapshot is still taken and the ref map still refreshes — the diff only changes *what is printed*. Refs in the diff are current and clickable. This attacks the re-snapshot tax that is agent-browser's worst real-world cost, on top of refs that already go stale far less (Change 2).

---

## Change 5 — `batch`

```
chrome-relay batch '[{"tool":"chrome_navigate","args":{...}}, {"tool":"chrome_snapshot","args":{...}}]'
chrome-relay batch --stdin   # JSON array on stdin
```

One HTTP POST, one native-messaging message, sequential execution in the extension, `--bail` stops at first error (default on). Response is an array of per-command envelopes. Amortizes both the ~110ms Node CLI startup and the HTTP/native round-trip across N actions. (Theirs: `commands.rs:1709-1760` — single daemon round-trip, sequential, no parallelism. Same here; parallel-within-batch is a non-goal.)

Mind the native-messaging size limit (1 MB host→extension per message); reject oversized batches with `invalid_arguments`.

---

## Change 6 — `get` one-liners

```
chrome-relay get text  <css|@ref>
chrome-relay get value <css|@ref>
chrome-relay get attr  <css|@ref> <name>
chrome-relay get count <css>
chrome-relay get title | url
```

Plain value to stdout, nothing else. All resolvable through the existing `chrome_evaluate` plumbing plus ref resolution from Change 2; this is mostly CLI sugar + one small extension handler. Stops agents from paying for a full snapshot to read one field.

---

## Change 7 — `skills get core`

```
chrome-relay skills [list]
chrome-relay skills get core [--full]
```

A markdown agent guide (`packages/cli/skills/core.md`) shipped inside the npm package and printed by the CLI — always version-matched to the installed binary. The installable `SKILL.md` for Claude Code/Codex becomes a thin discovery stub: "run `chrome-relay skills get core`". This is agent-browser's distribution pattern (`cli/src/skills.rs`; stub-vs-content rule documented in their `AGENTS.md:17-26`) and it solves our doc-drift problem for free. The guide's first section is the core loop: `snapshot -i` → `click @eN` → `snapshot --diff`.

---

## Change 8 — Error hygiene

Observed live during testing: `click` with a non-matching selector returned `code: "internal_error"` with a raw JS stack (`Error: Element not found for selector: ...\n at vt (<anonymous>:1:86)`) instead of `element_not_found`. The structured `RelayError` system exists; older handlers throw plain `Error` past it. Sweep `apps/extension/src/browser/handlers/*` so every thrown error maps to a closed-set code, and add `stale_ref` (Change 2). Acceptance: no `internal_error` reachable from any normal agent mistake (bad selector, dead ref, closed tab, timeout).

---

## Explicit non-goals

- **Rust rewrite / daemon.** Their 100%-Rust story is install-footprint (no Node dependency), not product. Our extension is necessarily JS and the token wins above dwarf the 110ms Node startup. Revisit only if batch + the above land and latency still bites.
- **`find` semantic locators.** Correction after review: the earlier claim that `find` is "plain CSS underneath" cited the wrong handler — `actions.rs:6222` is only the generic `find <css>` command. The documented `find role|text|label|placeholder|testid` forms route to `handle_getbyrole` / `handle_semantic_locator` (`actions.rs:5902, :5986`), which are in-page JS heuristics over `aria-label`/`textContent` — real semantic-ish locators, though not AX-tree-grade role computation. The non-goal stands on its own merits: with actionable+healing refs and `get`, the staleness escape-hatch `find` provides matters much less here. Later, maybe.
- **MCP server.** Correctly absent from both tools. CLI + skill is the interface.
- **Headless/sandbox mode, cloud providers.** That's agent-browser's product. Ours is the real browser.
- **Auto-re-snapshot after every action.** Tempting fix for staleness, but it reintroduces the token tax on every click. `--diff` + healing refs is the better trade.

## Sequencing

1+2 together (one PR — snapshot without actionable refs is half a feature), then 8 (small, partly inside 2), then 3, 4, 6, 5, 7. Changes 1–4 are the ones that change benchmark outcomes; 5–7 are quality-of-life.

## Reviewer pointers

- Render format + role lists: `agent-browser/cli/src/native/snapshot.rs` (render_tree :1060, roles :11, cursor-interactive sweep :609, ref assignment :342)
- Ref resolution + staleness heal: `agent-browser/cli/src/native/element.rs` (:18 RefMap, :299 resolve_element_center)
- Diff: `agent-browser/cli/src/native/diff.rs:103`
- Our touchpoints: `packages/protocol/src/index.ts` (tool names/schemas), `packages/cli/src/program.ts` (commands), `apps/extension/src/browser/tools.ts` + `handlers/` (handlers), `apps/extension/src/browser/cdp.ts` (CDP session)
- Measurements: `~/.claude/jobs/3904b6a8/tmp/{ab_full,ab_int,cr_read,cr_read_int,cr_ax,cr_ax_int}.txt`
