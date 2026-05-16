# What's left from the boundaries.md roadmap

Status as of 2026-05-16 against `chrome-relay@0.3.1`. Companion to
[`./boundaries.md`](./boundaries.md) (the original capability roadmap) and
[`./issues.md`](./issues.md) (rough edges on what *did* ship).

This doc only covers boundaries.md §2 items that are not yet in the CLI.

---

## Snapshot — what 0.3.x actually shipped

| § | Capability | Status |
| --- | --- | --- |
| 2.1 | Groups (`group create/list/close` + `--group`) | shipped |
| 2.2 | Viewport (`viewport set/preset/clear/list`) | shipped (see issues #1, #2) |
| 2.3 | Region screenshots (`--bbox`, `--selector`, `--padding`) | shipped |
| 2.4 | A11y tree (`ax`, `--interactive-only`, `--root`) | shipped |
| 2.4b | Click-by-AX-id (`click-ax --node`) | shipped (bonus on top of 2.4) |
| 2.7a | Network capture (`network read/body/har/clear`) | shipped (see issues #3–#6) |
| 2.7c | Console (`console --level/--since/--clear`) | shipped |
| 2.8 | Value-aware `read -i` (state on every interactive node) | shipped |
| — | `self-reload` (restart extension service worker) | shipped, was not on the roadmap |

Nine of the roadmap surfaces went out in the 0.2.5 → 0.3.x drop. The remaining list is
short.

---

## Not yet shipped, ranked by leverage

### 1. §2.7b — cookies + storage

The smallest remaining surface and the one with the largest forward dependency. Read-side
only is enough to unlock the next-gear network-replay flow (§2.9).

CLI shape already drafted in `boundaries.md`:

```
chrome-relay cookies --tab <id> --domain api.example.com
chrome-relay storage --tab <id> --domain example.com --type local
chrome-relay storage --tab <id> --domain example.com --type indexeddb --db <name>
```

CDP primitives: `Network.getCookies`, `Storage.getStorageKeyForFrame` /
`Storage.getStorageKeyData`, `DOMStorage.getDOMStorageItems`. Write-side stays gated
behind a confirmation flag so a runaway agent can't quietly hijack a session.

Why high-leverage: it's the missing piece for "log in once in Chrome, replay the API
outside Chrome." Without cookies/storage, every replay attempt re-auths from scratch.

Estimated cost (per boundaries.md): ~150 LOC.

### 2. §2.6 — high-fps capture (screencast / frame strip / GIF)

Use case: verify that the install-modal collapse animation (~360 ms scale toward the
toolbar icon) actually plays. Boundaries.md §2.6 lays out the full design —
`Page.startScreencast` with `everyNthFrame: 2` for ~30 fps, then assemble into:

- frame strip (default — best for LLM eyes)
- GIF (`--gif` — for sharing with humans)
- sparse keyframes (`--keyframes 4` — cheapest when motion isn't crucial)

CLI shape already drafted:

```
chrome-relay record start --tab <id> --fps 30
chrome-relay record stop  --tab <id> --output anim.strip.png --format strip
```

Until this ships, sub-second motion is invisible to agents — `screenshot` only captures a
single instant and `read` / `ax` don't know about animations.

Estimated cost (per boundaries.md): ~300 LOC.

### 3. §2.5 — natural-language element resolver (`chrome-relay find`)

The vision: agent asks `chrome-relay find "the blue Save button"`, a small (Haiku-tier)
model sees the AX tree, returns the `backendDOMNodeId`. The big agent never sees the
1500-token tree — it sees three lines.

Now that `ax` and `click-ax` ship, the substrate is in place. What's left is:

- the resolver loop (POST AX tree + description to a small model, parse out a node id)
- the env-var contract for where the resolver runs (option C from §2.5 — caller-provided
  endpoint with an option B fallback to a hosted Haiku-tier call)
- `chrome-relay find <description>` and `chrome-relay click-find <description>` wrappers

Estimated cost (per boundaries.md): ~150 LOC + an env-var contract.

This is the "intelligent truncation" pattern Claude in Chrome uses. Worth doing — but the
ergonomics matter a lot (which model, who pays, what happens on a miss). Getting it wrong
silently is worse than not having it.

### 4. §2.9 — network capture → replay

The strategic bet. Once §2.7b (cookies/storage) is in, the next gear is replay:

```
chrome-relay capture start --intent "find the search endpoint behind this dashboard"
chrome-relay capture summarize        # returns 1-2 candidate routes, not raw HAR
chrome-relay capture replay --route <id> --params {...}
chrome-relay capture save --route <id> --as "search-users"
```

Critical design rule from the wiki and from boundaries.md: **never dump raw HAR into the
model.** Capture locally, summarize locally, return a typed tool shape. This is the part
of the roadmap that turns chrome-relay from "browser bridge" into "API discovery for SaaS
workflows."

Multi-week scope. Should land after #1 (cookies/storage), since without those a replayed
call can't authenticate.

Also worth threading into this: the §2.7a issues in `issues.md` (#3–#5) — silent
body-less HAR exports, chrome-extension:// noise in the capture, no body-truncation flag.
Those need to be fixed before HAR is a reliable substrate for replay.

### 5. §2.7d — performance metrics (optional)

Boundaries.md explicitly de-prioritizes full Tracing / HeapProfiler — the payloads are MB
flame graphs an agent can't reason about. The cheap version is a
`chrome-relay perf metrics --tab <id>` that returns `PerformanceObserver` web-vitals (LCP,
CLS, INP). Ten numbers, agent-actionable, ~50 LOC.

Worth doing as a one-afternoon side quest if it ever comes up. Not on the critical path.

---

## Suggested sequence from here

1. **§2.7b cookies/storage (read-side)** — one afternoon. Unblocks the replay future.
2. **§2.6 screencast (strip-format default)** — couple of afternoons. Closes the
   animation-verification blind spot.
3. **Fix the §2.7a network ergonomics in `issues.md` #3–#5** — half a day. Cheap quality
   pass on already-shipped substrate.
4. **§2.5 NL find** — once there's a clear answer on who pays for the resolver model.
5. **§2.9 capture → replay** — the multi-week bet. Land after everything above.

That order matches the original "cheapest first, biggest user-visible delta per
afternoon" heuristic from `boundaries.md` §4 — it just trims the items 0.3.x already
shipped.
