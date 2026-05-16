# Three-features pass — what I shipped + decisions I want your eyes on

**Shipped at commit `75c17b0`.** Three features from `boundaries.md`'s recommended sequence:

- §2.8 — value-aware `read -i`
- §2.2 — viewport emulation + presets
- §2.3 — region screenshots (`--bbox` / `--selector`)

Test counts: 156 across all packages, all green (was 137 before the pass). No live Playwright E2E added — see §6 below.

This doc isn't a feature spec — it's the **calls I had to make where I could see at least two reasonable answers**, written so you can override any of them in one read. Each item: *what I did*, *what the tradeoff is*, *what I want from you* (acknowledge / change).

---

## 1. §2.8 — should we redact password input values in `read -i`?

**What I did.** Password inputs return their `value` verbatim, same as text inputs.

**Why.** `read -i` is a deliberate caller action — the agent typed `chrome-relay read --tab N -i` against a page it chose to inspect. Inside the in-page snapshotter we already see every DOM node; redacting one specific input type would be security theater (the agent can always read the same value via `chrome-relay js 'document.querySelector("input[type=password]").value'`). And without it, the agent can't verify "did my fill of the password field land?"

**What I want from you.** Confirm. If you'd rather we redact (and force agents to use the `js` escape hatch), flag and I'll add a `state.value = "<redacted>"` for `type=password` with a separate `state.valueLength` so callers can still verify "something is in there." Trivial change either way.

---

## 2. §2.8 — `state` field is only attached when non-empty; non-interactive nodes don't get it at all

**What I did.** Two-stage filter:
- non-interactive nodes: no `state` field whatsoever
- interactive nodes: `state` only when it has at least one entry (so a plain `<a>` carries no `state` field; an `<input>` carries `state.value` even when empty string)

**Why.** Payload weight matters. A typical page has 50 interactive elements; if every one carried `state: { value: "", checked: false, ... }` we'd double the bytes. The empty-suppression keeps the schema honest: the *presence* of `state` means there's something to know.

**What I want from you.** Confirm the agent-facing contract: callers must use `node.state?.value`, not assume `state` exists. Slightly less ergonomic than always-present `state: {}`. I think the byte savings win; you may disagree.

---

## 3. §2.2 — one `chrome_viewport` tool with `action: set|preset|clear|list` vs four separate tools

**What I did.** Single tool. The CLI's `viewport set` / `viewport preset` / `viewport clear` / `viewport list` subcommands all marshal to `chrome_viewport` with different `action` values.

**Why.** Keeps `TOOL_NAMES` surface small (we're already going from 10 → ~25 tools across the boundaries roadmap; every avoided entry helps). Single tool is also easier to mock in tests — one handler to stub.

**Alternative.** Four tools: `chrome_viewport_set`, `chrome_viewport_preset`, `chrome_viewport_clear`, `chrome_viewport_list`. More discoverable in raw protocol use (no hidden `action` enum). More test mocks.

**What I want from you.** Confirm. If you'd rather have one-tool-per-verb (more printingpress-style "agent-native CLI"), it's a 20-line refactor.

---

## 4. §2.2 — viewport override wipes on detach; no auto-reapply

**What I did.** Documented in the CLI `--help`: "The override survives navigations within the tab but is wiped when the debugger detaches (e.g. another extension takes over). Closing the tab clears it. Re-run after detach if the page snaps back to its default size."

**Why.** Auto-reapply would require us to track "what viewport is currently set on each tab" in the extension's service worker, plus re-apply on every CDP attach. Service workers get torn down; we'd need persistent storage. The doc explicitly says this is "a much bigger lifecycle commitment." I lived with the documented quirk.

**What I want from you.** Acknowledge. Or say "no, persist + reapply" and I'll add the storage layer (extends `groups` task #2.1 territory anyway).

---

## 5. §2.2 — preset list (10 devices, hardcoded UA strings)

**What I did.** Picked these:
- mobile: `iphone-14`, `iphone-15-pro`, `iphone-se`, `pixel-7`, `galaxy-s23`
- tablet: `ipad-mini`, `ipad-pro-11`
- desktop: `desktop-1280`, `desktop-1440`, `desktop-1920`

UA strings hardcoded for the mobile devices (desktop presets don't override UA).

**Why.** Covers the modal "small mobile / standard mobile / tablet / small laptop / standard laptop / big monitor." UA strings are real device fingerprints from late 2024; the `(iPhone)` / `(Android)` substrings are what content-negotiating sites actually check, so version drift doesn't matter much.

**What I want from you.** Two specific calls:
- **Add anything missing?** I left out: `iphone-16-pro`, `galaxy-tab`, `surface-pro`, `chromebook-typical`. None felt load-bearing but you might know better.
- **Drop UA override on desktop presets?** Today desktop presets only set width/height/dpr — no UA. If a site UA-sniffs to bounce desktop Chrome to a mobile path, our `desktop-1280` preset on an iPad-shaped tab wouldn't override the iPad UA. Want me to add a "real desktop Chrome" UA string to those presets?

---

## 6. §2.3 — `--selector` reuses `locateForClick`, which scrolls

**What I did.** For `--selector`, the extension calls the existing `locateForClick(selector)` which does `scrollIntoView({ block: "center", inline: "center" })` before measuring the bounding rect.

**Why.** Without scrolling, off-screen selectors give negative `clip.y` values, and CDP either returns weird output or clips to the visible region. The doc's §2.3 explicitly flagged this: "We should `scrollIntoViewIfNeeded` first, then capture."

**Tradeoff.** Scrolling has page-side effects: `IntersectionObserver` callbacks fire, lazy-load images start downloading, sticky elements re-pin. For agent verification ("did the modal close") this is fine. For some pages — Twitter, Instagram, infinite scrollers — it can shift virtual content under the screenshot.

**What I want from you.** Acknowledge. If this bites later, the fix is a separate `getElementBoundsNoScroll` helper that returns `null` when the element is fully off-screen, and we add a `--no-scroll` flag.

---

## 7. §2.3 — `--selector` uses first match (no `nth-match` flag, no error on multiple)

**What I did.** `document.querySelector` semantics: first match wins, silently. If your selector matches 5 cards, you capture card #1.

**Why.** Matches how every other chrome-relay tool that takes a selector works (`click`, `fill`, `type`). Consistency over surprise.

**What I want from you.** Confirm. Alternative would be: print a stderr warning when `querySelectorAll(selector).length > 1`. Cheap to add; you may want it.

---

## 8. §2.3 — `--bbox` parsing is strict (rejects negative, non-numeric)

**What I did.** `parseBbox("x,y,w,h")` requires 4 positive finite numbers. Throws on anything else.

**Why.** Negative coordinates and non-numeric strings are almost always user error, not "I really want to capture from x=-10." Easier to fail loudly than to silently capture wrong-region.

**What I want from you.** Confirm. If you ever need negative-x (capturing into the page chrome / sticky-positioned content) we revisit.

---

## 9. §2.3 — `captureBeyondViewport: true` is forced when `--bbox` or `--selector` is passed

**What I did.** Any region capture sets `captureBeyondViewport: true` regardless of `--full`.

**Why.** A bbox / selector might extend below the fold; without this flag CDP clips to viewport and you get a partial image without warning. Cleanest semantics: "you asked for THIS region, you get THIS region."

**Tradeoff.** Marginally bigger CDP roundtrip when the region is fully on-screen (CDP renders the full page to find the clip). Negligible in practice — a few extra ms.

**What I want from you.** Acknowledge. The alternative ("respect `--full` literally even when it makes `--selector` return partials") felt strictly worse.

---

## 10. Test coverage strategy — unit only, no live Playwright E2E added

**What I did.** Added 19 new vitest unit tests (13 in `page-actions.test.ts` for §2.8, 6 in `program.test.ts` for §2.2/§2.3). Did **not** extend `apps/extension/test/e2e/` with Playwright tests against the real loaded extension.

**Why.** Unit tests + the CLI parse tests give us: "the snapshotter returns the right shape," "the CLI sends the right JSON to the bridge." The remaining unknown is "does the extension actually fire the CDP call." That requires a Playwright pass against a real loaded extension; ~30-60 min per feature and easy to keep flaky.

**What I want from you.** Pick one of:
- **A: stay unit-only**. Ship now. The CDP call site is tiny enough that "no test" is acceptable risk.
- **B: I add Playwright e2e for §2.2 (viewport) and §2.3 (selector screenshot)** — those are the most visible. §2.8 doesn't really benefit (the snapshotter logic is fully testable in jsdom).

I left it on A unless you say otherwise.

---

## 11. Codebase cleanups I made along the way

The user feedback was "make the codebase better as you write code." Small in-passing cleanups in this commit:

- `tools.ts` — added named-section comments (`§2.3 — region screenshots`, `§2.2 — viewport emulation`) so the boundaries.md sections are greppable from the source.
- `viewport-presets.ts` — new file with a top-of-file rationale block explaining why each preset is in the list. Anyone adding the 11th preset will know what bar to clear.
- `tools.ts` parseBbox helper — extracted instead of inlining, so the test surface is obvious.

**Did not do** (would deserve a follow-up, not slipped silently into a feature commit):
- The `chrome.tabs.query({active:true,currentWindow:true})` call inside `getActiveTab()` is duplicated in 3+ tool handlers as the fallback path. Could be hoisted.
- `apps/extension/src/browser/cdp.ts` has an `attached: Set<number>` but no `detached` event listener — if Chrome auto-detaches the debugger (it does, after ~30s idle), our set goes stale. This is a real bug; not mine to fix in a viewport-emulation commit.
- `packages/cli/src/program.ts` is 350 lines of commander chains; each new feature appends another ~30 lines. Will eventually want to split into one-file-per-command-group. Not now.

**What I want from you.** Acknowledge — flag any of these as "fix now" and I'll squash them in before the next feature pass.

---

## 12. What's next — boundaries.md remaining work

For your sequencing convenience, the boundaries.md items that are NOT yet shipped:

- **§2.7c console capture** — green/ready per my earlier eval. Probably the next 30-min feature.
- **§2.1 groups** — needs the lifecycle design pass (Hard vs Soft, see prior message).
- **§2.4 a11y tree** — needs the interactive-only filter list spec.
- **§2.5 smart resolver** — needs the model-interface contract.
- **§2.6 screencast** — needs frame buffer + timing semantics.
- **§2.7a network capture** — needs HAR spec.
- **§2.7b cookies/storage write** — needs the safety-flag design.
- **§2.9 capture → replay** — vision-level, waits on §2.7a.

Say "do §2.7c next" or "fix the cdp.ts detach bug first" or anything else and I'll execute.
