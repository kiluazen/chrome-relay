# Agent loop performance

What an agent actually waits on is the loop: open a page, read it, act, read the result. This doc records how that loop was measured, what was slow or wrong, what changed, and what is left.

## How it is measured

`apps/extension/scripts/agent-loop-bench.mjs` drives the production path (real CLI binary → real native host → extension → CDP) in isolated headless Chromium. It never touches your Chrome or desktop focus.

```sh
pnpm build:cli
pnpm --filter chrome-relay-extension exec wxt build --mode development
node apps/extension/scripts/agent-loop-bench.mjs --iterations 8 --real               # documented loop with explicit waits
node apps/extension/scripts/agent-loop-bench.mjs --iterations 8 --real --no-wait-step # navigate → snapshot → click → snapshot
node apps/extension/scripts/agent-loop-bench.mjs --iterations 8 --real --composite    # navigate --snapshot → click --snapshot
node apps/extension/scripts/agent-loop-bench.mjs --iterations 0 --probe-snapshot      # where a big snapshot's time goes
```

Fixtures: a 200-row page whose 1.2 s image holds the load event, and a 1,500-row page. `--real` adds Hacker News, Wikipedia and GitHub. Each loop also checks correctness: after a navigating click, the second snapshot must describe the new URL.

The extension must be a development build so its ID matches the native-host manifest the bench writes (the ID is derived from the manifest key).

## Results

Historical measurements recorded with the agent-loop PR, in headless Chromium on the development Mac. The 0.9.0 release checks now reject missing targets, loading snapshots and stale post-click URLs; the current validated measurements are in `release-0.9.0.md`. This table is not a fresh baseline comparison.

| | Before (documented loop) | Default loop | `--snapshot` loop |
|---|---:|---:|---:|
| Commands per loop | 7 | 4 | 2 |
| CLI overhead per command | 78 ms | 48 ms | 48 ms |
| 200-row page, full loop | 3,197 ms | 424 ms | 353 ms |
| 1,500-row page | failed every run | 1,165 ms | 1,109 ms |
| Hacker News | wrong page read; click never reached | 1,025 ms | 822 ms |
| Wikipedia | wrong page read | 994 ms | 926 ms |
| GitHub | wrong page read | 604 ms | 620 ms |

"Wrong page read": the snapshot described the new tab's blank placeholder, so the agent had to notice and retry. The command count matters more than the milliseconds: every command is an agent turn, and a turn costs seconds of model time.

## What was wrong, and what changed

### Reads raced navigation (correctness)

A tab created with a URL starts on `about:blank`, whose `readyState` is already `complete`. On any page slower than that, `navigate --new` → `wait --load` → `snapshot` passed the wait instantly and snapshotted an empty page. The local fixtures hid this; every real site hit it.

- `navigate` waits for the new document (default `--wait domcontentloaded`; `load`, `commit`, `none` available) and reports `ready`, `readyState`, `waitedMs`, `loadFailed`. A slow page returns `ready: false`, never an error.
- Readiness ignores the document while Chrome reports `tab.pendingUrl` (the uncommitted navigation).
- `snapshot` waits (≤10 s) for a pending navigation instead of reading the document being replaced, and flags `Loading:` if it is still loading.
- `wait --load` is no longer satisfied by the placeholder.

### Waiting for the wrong event (speed)

Agents waited for `load`, which waits for every image and tracker. During those measurements, GitHub stayed `interactive` for 20 s in the background. DOMContentLoaded makes the new document available; a hydrated app can still need a wait for its required element or text.

### False `click_intercepted` below the fold (correctness)

After scrolling a ref into view, `DOM.getNodeForLocation` hit-tested the viewport point as if the page had not scrolled (verified on HN's "More": it named a story link 500 px up; `elementFromPoint` at the same point returned the link). Ref clicks now locate and hit-test inside the page in one `Runtime.callFunctionOn` (2 CDP round trips instead of up to 7), and re-center an element once before refusing, which also clears sticky headers.

### Snapshot refs dead on arrival on big pages (correctness)

The ref map caps at 2,000 entries and evicted the oldest, which on a page with >2,000 interactive elements were the top-of-page refs of the snapshot being built. Eviction now takes other tabs' refs first and never the current snapshot's.

### Sweep wrote into the page (speed, side effect)

The cursor-interactive sweep tagged elements with `data-cr-sweep` attributes, then walked the full DOM (`DOM.getDocument depth:-1`, 141 ms of a 550 ms Wikipedia snapshot) to find them. It now returns element handles and resolves each with `DOM.describeNode`: nothing is written to the page, and cost scales with matches (≤100). The AX read runs in parallel.

### CLI startup (speed)

Each command is a fresh Node process. The first `fetch()` loads undici (~20 ms), and even `import "node:http"` loads it in ESM, because building the module facade touches a lazy getter. The hot path uses `node:http` through `createRequire`, and `diff` loads only for `snapshot --diff`. Per command: 78 → 48 ms; bare Node startup is ~26 ms of that.

### Screenshot and hover below the fold (correctness)

`screenshot --selector` passed a viewport-relative clip while Chrome reads it in document coordinates, so any element below the fold captured a blank region. `hover <selector>` hovered off-screen coordinates instead of scrolling the element into view.

## One-call actions

`navigate`, `click`, `fill`, `type` and `keys` accept `--snapshot`: the action, then an interactive snapshot of the tab it acted on, in one process.

For input actions the snapshot first waits for the page to react. The action arms a tracker before dispatching input:

- a `MutationObserver` in a CDP isolated world (page scripts can't see it);
- an in-flight request count from CDP Network events. Requests older than 1 s don't count, so long-polls and beacons can't pin it.

The snapshot waits until no recent request is in flight and the DOM has been quiet for 150 ms, at least 300 ms after the action and at most 2 s. If the input starts a navigation, the readiness wait takes over. Polling runs from the service worker, since a background tab's own timers can be throttled. `snapshot --settle` uses the same wait standalone.

CLI 0.9.0 checks the connected extension before readiness navigation, composite actions, settle and recording starts. With an extension older than 0.9.0, these commands fail with `unsupported_tool` before browser side effects. Update both components; `navigate --wait none` remains available with an explicit wait for the required page state.

## Known limits, not addressed

- **AX tree transfer is the snapshot floor.** `Accessibility.getFullAXTree` ships every node, including ~35% `InlineTextBox` entries, and there is no filter. It takes ~290 ms of a 340 ms 1,500-row snapshot and ~400 ms on Wikipedia. Per-role `queryAXTree` is slower (168 ms for links alone on Wikipedia) and loses the hierarchy.
- **Snapshot tokens on long pages.** Wikipedia `-i` is ~65–75 KB. A viewport-only mode, or printing the profile prefix once instead of on every ref, would cut tokens. The prefix-per-ref format is a deliberate routing decision; changing it is a product call.
- **Node startup.** ~26 ms per command is Node itself. Avoiding it needs a resident process, which the one-host-per-profile design deliberately avoids.
- **Shape elision can hide a distinct last sibling.** With `-i`, a "More" link at the end of 60 identical story links is elided with them. HN's real rows are not identical, so this didn't show up there.
- **The HN hit-test misfire isn't reproduced in a fixture.** `below-fold.html` guards the path, but only live HN (`--real`) reproduced the stale-scroll hit test.
