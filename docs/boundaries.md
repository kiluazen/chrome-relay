# Chrome Relay — what it does, what's blocked, where to push

Written 2026-05-16 against `chrome-relay@0.1.x` and the v1.0.x extension. Code-grounded in:

- `packages/protocol/src/index.ts` — the 10 tool names + the bridge messages
- `apps/extension/src/browser/tools.ts` — what each tool actually does
- `apps/extension/src/browser/cdp.ts` — how we attach to a tab via `chrome.debugger`
- `apps/extension/wxt.config.ts` — extension permissions

Wiki context I leaned on (so I'm not duplicating debates already had):

- `~/wiki/comparisons/browser-tool-verbosity-benchmark.md` — chrome-relay vs Computer Use vs Browser Use, token-by-token
- `~/wiki/comparisons/browser-tool-io-and-agent-loops.md` — I/O contracts side-by-side
- `~/wiki/concepts/network-api-discovery-for-browser-agents.md` — the "next gear" direction
- `~/wiki/concepts/browser-bridge-product-architecture.md` — why the extension+bridge split is right

Visibility (analytics, who's installing, feedback) lives in `./visibility.md`. **This doc is product + capabilities.**

The goal is to give people zero reason to switch off chrome-relay. The way we do that is by being honest about what only this real-Chrome-profile bridge can do, then closing the obvious gaps with clean code on top of CDP primitives we already half-use.

---

## 1. What chrome-relay does today

Pipeline:

```
agent / shell
  └─ chrome-relay CLI
        └─ localhost bridge @ 127.0.0.1:12122
              └─ native messaging host (~/.chrome-relay/run-host.sh)
                    └─ Chrome extension (cpdiapbifblhlcpnmlmfpgfjlacebokb)
                          └─ real tabs in the user's default Chrome profile
```

The extension attaches to a target tab via `chrome.debugger.attach({ tabId }, "1.3")` (CDP protocol 1.3), then sends raw CDP commands. `apps/extension/src/browser/cdp.ts` keeps an `attached: Set<number>` so concurrent ops on the *same* tab serialize correctly while ops on *different* tabs already run in parallel.

Ten tools today:

| Tool name                | CDP primitive used                                  |
| ------------------------ | --------------------------------------------------- |
| `get_windows_and_tabs`   | `chrome.tabs.query` (extension API, not CDP)        |
| `chrome_navigate`        | `chrome.tabs.create` / `chrome.tabs.update`         |
| `chrome_switch_tab`      | `chrome.tabs.update { active: true }`               |
| `chrome_close_tabs`      | `chrome.tabs.remove`                                |
| `chrome_screenshot`      | CDP `Page.captureScreenshot { captureBeyondViewport }` |
| `chrome_read_page`       | `chrome.scripting.executeScript` of a snapshotter, runs in page world |
| `chrome_click_element`   | locate via in-page `evalInTab`, then CDP `Input.dispatchMouseEvent` triple (hover → press → release). The triple matters — Material ripples and some anti-bot heuristics only register clicks that follow a mouse-move. |
| `chrome_fill_or_select`  | in-page `evalInTab` (React-controlled inputs need the synthetic input event the page itself fires) |
| `chrome_keyboard`        | CDP `Input.dispatchKeyEvent`                        |
| `chrome_type`            | optional focus via `evalInTab`, then CDP `Input.insertText` |
| `chrome_evaluate`        | CDP `Runtime.evaluate` with `awaitPromise: true`; 15s default timeout |

Browser scope: one default profile. "Active tab" is the default target if `--tab` is omitted. `chrome_screenshot --tab <id>` auto-activates the tab first (Chrome only screenshots visible tabs via this CDP route).

Distribution: published Chrome Web Store ID is `cpdiapbifblhlcpnmlmfpgfjlacebokb`; the native host manifest also allowlists a legacy dev ID and a local-unpacked dev ID, so dev and prod extensions both talk to the same host.

---

## 2. Roadmap — capabilities to push, deep on each

Order is rough priority. Every section names the CDP primitive that unblocks the feature, the on-the-wire payload, and a sketch of the CLI surface. The point of going technical here: each of these is "1-3 afternoons of clean code on a primitive we already use", not a new architecture.

### 2.1 Groups — parallel autark hypotheses

**The agent need:** autark runs hypotheses sequentially today because they fight over the same active tab. H01 is reading Gmail; H02 wants to open Reddit; both call `chrome_screenshot` which auto-activates the tab; they collide.

**What CDP already gives us:**

- `chrome.debugger.attach({ tabId }, "1.3")` is per-tab. Two debugger sessions on two tabs run independently — our `Set<number>` already tracks this.
- `chrome.windows.create({ url, focused: false })` returns a `windowId`. Windows are visually distinct in OS-level taskbar; the user can see "this window is autark-bidsmith-h01."

**Mechanism:**

A *workspace* is a named handle for a Chrome WINDOW. We store `{ name, windowId, createdAt, label }` in `chrome.storage.local`. Every tool grows an optional `--workspace <name>` flag; when present, "active tab" means "active tab of *that workspace's window*", not "any window."

```
chrome-relay workspace create bidsmith-h01     # opens new window, prints windowId
chrome-relay workspace list                    # name, windowId, tabCount, alive:bool
chrome-relay --workspace bidsmith-h01 navigate https://reddit.com
chrome-relay --workspace bidsmith-h01 screenshot -o evidence.png
chrome-relay workspace close bidsmith-h01
```

Implementation cost: extension-side routing only. Native host doesn't change. ~150 LOC.

**Naming history (0.4.0):** this primitive used to be called `group` until a live demo turned up the obvious collision — Chrome's UI calls something else a "group" (the colored, collapsible folder inside one window). Renamed to `workspace`; the name `group` is now used for Chrome's native tab-group primitive, which we expose separately via `chrome-relay group create <name> --tabs <ids> --color <c>`. The two coexist: `--workspace W --group G` targets the active tab in tab-group G inside window W.

**Subtle:** the popup currently shows "one bridge, one extension." That stays correct — workspaces are routing inside the extension. The popup should grow a small `Workspaces: 2 active` line so the human can see the chrome-relay-managed windows from one place.

### 2.2 Viewport emulation — phone view from CLI

**The agent need:** when chrome-relay verifies a dashboard, it sees whatever viewport the user's Chrome window happens to be. We shipped layout bugs that only existed below 540px because we screenshotted at 750px. The agent had no way to flip viewports.

**What CDP gives us:**

```
Emulation.setDeviceMetricsOverride {
  width: 390,                  // CSS px
  height: 844,
  deviceScaleFactor: 3,        // 2 or 3 for retina
  mobile: true,                // affects meta viewport interpretation
  screenWidth: 390,
  screenHeight: 844,
  positionX: 0,
  positionY: 0,
  dontSetVisibleSize: false,
  screenOrientation: { type: "portraitPrimary", angle: 0 }
}
Emulation.setTouchEmulationEnabled { enabled: true, maxTouchPoints: 1 }
Emulation.setUserAgentOverride { userAgent: "...iPhone..." }
Emulation.clearDeviceMetricsOverride
```

The override survives navigations within the tab but is wiped when the tab closes or detaches.

**CLI surface:**

```
chrome-relay viewport set --tab <id> --width 390 --height 844 --mobile --dpr 3
chrome-relay viewport preset iphone-14            # alias: 390x844 mobile dpr=3
chrome-relay viewport preset pixel-7              # alias: 412x915 mobile dpr=2.625
chrome-relay viewport preset desktop-1280         # 1280x800 dpr=2 no touch
chrome-relay viewport clear --tab <id>
```

Presets are just a table in `apps/extension/src/browser/presets.ts`. Add ~12 of them — covers every device the user might care about.

Implementation cost: ~80 LOC + a presets table.

### 2.3 Region screenshots — `--bbox` and `--selector`

**The agent need:** an LLM rarely needs the whole tab. It needs the header, the third card, the toast that just appeared. A full-tab screenshot of a dashboard is ~250 KB and ~1500 tokens for the model to "see." A header-only screenshot is ~15 KB and ~200 tokens. **10× cheaper on every screenshot.**

**What CDP gives us:**

```
Page.captureScreenshot {
  format: "png",
  clip: { x, y, width, height, scale: 1 },
  captureBeyondViewport: true        // clip can extend past the fold
}
```

**CLI surface:**

```
chrome-relay screenshot --tab <id> --bbox 0,0,1280,80      # explicit rect
chrome-relay screenshot --tab <id> --selector "header"     # element bbox
chrome-relay screenshot --tab <id> --selector ".product-card:nth-child(3)" --padding 8
```

`--selector` is the high-leverage variant: the extension resolves the selector inside the page (via `evalInTab` returning `getBoundingClientRect()`), passes that rect as `clip`. Callers reason in CSS, not pixels.

**Edge case to handle in code:** elements partially off-screen. We should `scrollIntoViewIfNeeded` first, then capture. Otherwise `clip.y` can be negative and Chrome returns weird output.

Implementation cost: ~60 LOC including the off-screen handling.

### 2.4 Accessibility tree — the smaller, more semantic page representation

This is the surface you asked me to explain technically. It's worth the words because it's the single biggest token-efficiency win for agents.

#### What the a11y tree actually is

Every modern browser maintains a **parallel tree** alongside the DOM. The browser builds it by walking the DOM, applying ARIA rules, computing accessible names, and pruning. The result is what screen readers consume.

Concretely: a `<div role="button" aria-label="Save changes" tabindex="0">…</div>` and a `<button>Save changes</button>` produce identical AX nodes:

```json
{
  "nodeId": "42",
  "role": "button",
  "name": { "type": "computedString", "value": "Save changes" },
  "value": null,
  "state": { "focused": false, "disabled": false },
  "focusable": true,
  "children": [...]
}
```

The pruning rules:

- Elements with `aria-hidden="true"` or `display: none` are excluded.
- Pure layout nodes (a `<div>` with no role, no listeners, no text content of its own) collapse into their parent.
- Presentational nodes (`role="presentation"` or implicit) collapse too.
- Names are *computed*: priority is `aria-labelledby` → `aria-label` → text content → `alt` → `title`.
- States that matter to interaction (`checked`, `expanded`, `pressed`, `disabled`, `selected`, `level`, `valuenow`) come along.

Empirically: an autark dashboard page DOM is around 6,000 nodes serialized to ~200 KB. The same page's a11y tree is around 90 nodes, ~7 KB. **30× smaller and far more semantic.** For an LLM, "the click target is a `button` named `Save changes`" beats "this is a `<div class="MuiButton-root jss-238 _btn _primary _sm">` with these 14 children."

#### CDP commands we'd call

```
Accessibility.enable
Accessibility.getFullAXTree { depth: -1, frameId?: <id> }   // whole tree
Accessibility.getPartialAXTree { backendNodeId: <id> }       // scoped
Accessibility.getAXNodeAndAncestors { backendNodeId: <id> }  // for resolution-back
```

Each AX node carries a `backendNodeId` we can immediately turn into a click target via `DOM.scrollIntoViewIfNeeded` + `Input.dispatchMouseEvent` (using the box-model coordinates from `DOM.getBoxModel`).

#### CLI surface

```
chrome-relay ax --tab <id>                              # full tree, JSON
chrome-relay ax --tab <id> --interactive-only           # filter to buttons/links/inputs/comboboxes
chrome-relay ax --tab <id> --root "main"                # subtree under a role
chrome-relay click-ax --tab <id> --node <ax-id>         # click by AX id, no CSS selector
```

`--interactive-only` is what most agent calls actually want. Reduces a 90-node tree to ~12 nodes on a typical dashboard.

#### How agents should use this

The flow becomes:

```
1. chrome-relay ax --tab <id> --interactive-only        # 12 lightweight AX nodes, ~1500 tokens
2. (agent decides: "click the AX node named Save changes")
3. chrome-relay click-ax --tab <id> --node ax_42        # extension translates to a coordinate click
```

vs the DOM way today:

```
1. chrome-relay read --tab <id> -i                      # 200 KB of DOM serialization
2. (agent decides: "click the .MuiButton-root[type=submit]")
3. chrome-relay click --tab <id> '.MuiButton-root[type=submit]'
```

The a11y tree avoids two failure modes: CSS-selector brittleness (Material's `jss-238` hash changes every build) and shadow-DOM blindness (a11y tree crosses shadow roots; DOM serialization doesn't unless we go out of our way).

Implementation cost: ~250 LOC. The big work isn't the CDP call, it's the serializer that flattens AX nodes into a compact JSON the LLM will be efficient with.

### 2.5 Smart resolver — `chrome-relay find "blue Save button"`

You asked: *"is it like intelligent truncation? where tool outputs are condensed down to whats relevant before the main agent sees it?"*

Yes — that's exactly what Claude in Chrome does and it's the right pattern. Here's how it works mechanically:

1. Caller asks for an element by natural-language description.
2. Extension fetches the AX tree (small).
3. A *small* model (cheap, fast — Haiku-tier or any small inference path) gets:
   - the AX tree (~1500 tokens) and the user's description ("the blue Save button").
   - returns the `backendNodeId` of the best match.
4. Extension turns that into a click target.

The big agent never sees the AX tree. It sees:

```
> chrome-relay find "the blue Save button"
{ nodeId: ax_42, role: "button", name: "Save changes", confidence: 0.94 }
```

Three lines instead of 1500 tokens of tree. That's the "intelligent truncation" — the small model is a compression step between the noisy page state and the expensive agent.

**CLI surface:**

```
chrome-relay find "the blue Save button" --tab <id>
chrome-relay click-find "the blue Save button" --tab <id>   # find + click in one
```

**Design choice:** where does the small model run?

- *Option A — local*: ship a tiny model (e.g., Phi or Qwen ≤3B) and run it via `node-llama-cpp` or `ollama` if present. Pros: no API key, no cost, no telemetry to a remote service. Cons: install footprint, cold-start latency.
- *Option B — remote*: call Anthropic / OpenAI Haiku-tier API with the user's own key from `~/.autark/credentials.json` (or a chrome-relay-specific env var). Pros: zero install footprint, instant. Cons: needs an API key, adds a roundtrip.
- *Option C — agent-provided*: the caller agent passes a `resolver_endpoint` env var; chrome-relay POSTs the AX tree + description there. Pros: the caller controls cost + model choice. Cons: agent harness has to provide it.

**Recommend C with a B fallback.** This keeps chrome-relay model-agnostic (matches its "any agent" positioning) while still being usable out of the box.

Implementation cost: ~150 LOC for the resolver loop + an env-var contract.

### 2.6 High-fps capture for sub-second interactions

You asked specifically about the install-modal collapse animation: 360ms transform+scale toward the terminal icon. Can chrome-relay capture that?

Yes. The right primitive is **`Page.startScreencast`**, not multiple screenshots.

#### What `Page.startScreencast` actually does

```
Page.startScreencast {
  format: "jpeg",
  quality: 60,           // 0-100
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1       // 1 = every browser frame (~60fps), 2 = ~30fps, 6 = ~10fps
}
```

Chrome then streams `Page.screencastFrame` events to the debugger, each with a base64-encoded JPEG + a metadata payload (timestamp, scroll offset, viewport size). We ACK each frame with `Page.screencastFrameAck { sessionId }` to throttle.

For the 360ms install-modal close anim at `everyNthFrame: 2` (~30fps):

```
360ms × 30fps = ~11 frames
each frame ~25 KB jpeg at 600x400 q=60
total: ~275 KB of raw frames
```

#### What artifact does the agent actually want?

This is your real question and the honest answer is **probably not a GIF**. GIFs are great for human eyes — bad for LLMs. Three artifact options:

**A) GIF**. One file, plays in a browser, easy to share with humans. The LLM sees a single image attachment and most multimodal models *do* read GIF metadata frame-by-frame, but the per-frame token cost is high and motion is poorly extracted. Use for human-facing artifacts (Slack message: "look what just happened"), not agent verification.

**B) Frame strip — a single tall image of N frames stacked**. The LLM sees the full motion sequence in one attachment, with no GIF parsing overhead. Models read this *very well*. Standard pattern in computer-vision agents. We assemble the strip with `sharp` or `canvas` in the extension (or in the CLI after streaming back).

**C) Sparse frames — "give me 4 keyframes evenly across the action"**. The agent gets 4 image attachments and reasons about the transition. Cheapest if 4 is enough. Best when motion isn't crucial (e.g., "did the modal close" — yes/no).

**Recommend B as the default**, A as `--gif`, C as `--keyframes 4`.

#### CLI surface

```
# explicit start/stop — the agent wraps an action between them
chrome-relay record start --tab <id> --fps 30
# ... agent triggers the action, e.g. chrome-relay click ".close-modal"
chrome-relay record stop  --tab <id> --output anim.strip.png --format strip
chrome-relay record stop  --tab <id> --output anim.gif        --format gif
chrome-relay record stop  --tab <id> --output anim/           --format keyframes --n 4

# one-shot helper for the common "record around this action" pattern
chrome-relay record --tab <id> --around "click .close-modal" --fps 30 --duration 1s --format strip
```

#### Sub-second concern — animation timing

Your example was a 360ms animation. The `everyNthFrame: 2` at ~30fps gives 11 frames across that window. The frame strip ends up ~600x4400px (4 frames vertically × ~600 px each at 11 frames tall). That's an artifact a model can ingest in one attachment, and the visual delta between frames 1 and 11 is enough for the LLM to verify "modal collapsed toward the terminal icon."

If 30fps misses the perceptual peak, we can dial to `everyNthFrame: 1` (~60fps) and downsample to half-size. That's 22 frames in 360ms at 300x200 — same ~275 KB total.

Implementation cost: ~300 LOC + an in-extension frame buffer + the `sharp`-or-equivalent strip assembly. The biggest care-area is buffering: a long screencast on a busy page can produce hundreds of frames. The extension needs a ring buffer with a max-frame-count default (~120) and a hard ceiling on memory (~50 MB).

### 2.7 The full DevTools surface — Network, Console, Storage, Cookies

You asked: *"can we get everything like network tab latency related stuff and etc.. the entire devtools into the cli?"*

Mostly yes. DevTools panels map to CDP domains. What's tractable, in priority of agent utility:

#### 2.7a Network — by far the biggest win

CDP `Network.enable` then we subscribe to:

```
Network.requestWillBeSent       fires before each HTTP request
Network.responseReceived        fires when headers come back
Network.loadingFinished         fires when body fully loaded
Network.loadingFailed           fires on CORS/timeout/etc
Network.dataReceived            chunks of body bytes
```

Each carries `requestId`, `timing { dnsStart, dnsEnd, connectStart, connectEnd, sslStart, sslEnd, sendStart, sendEnd, receiveHeadersEnd }`, `request { url, method, headers, postData }`, `response { url, status, statusText, headers, mimeType, encodedDataLength }`.

Bodies aren't streamed — you ask for them explicitly with `Network.getResponseBody { requestId }`.

**CLI surface:**

```
chrome-relay network --tab <id>                    # last 50 requests, headers + timings
chrome-relay network --tab <id> --tail             # live stream
chrome-relay network --tab <id> --filter graphql   # url substring filter
chrome-relay network --tab <id> --body <reqId>     # body for one request (opt-in)
chrome-relay network har --tab <id>                # full HAR file (HTTP Archive standard)
```

The HAR export is the killer feature. HAR is the universal "I have a network log, replay this" format — Postman, Insomnia, browsers, and proxy tools all import it. An agent can capture a HAR, then your `printing-press` style network-replay tooling (from `~/wiki/concepts/network-api-discovery-for-browser-agents.md`) compiles a HAR into a reusable Go CLI.

#### 2.7b Cookies + Storage — unblocks the network-replay future

```
Network.getCookies { urls: [...] }
Network.setCookie { name, value, domain, ... }
Storage.getStorageKeyForFrame { frameId } / Storage.getStorageKeyData
DOMStorage.getDOMStorageItems { storageId }
```

For session-bound API replay (the next-gear direction in `~/wiki/concepts/network-api-discovery-for-browser-agents.md`), agents need to pluck the session cookie / bearer / CSRF token from a logged-in tab and replay requests outside the browser. We expose that read-side now; we leave write-side gated behind a confirmation flag so an agent can't quietly hijack a session.

```
chrome-relay cookies --tab <id> --domain api.example.com
chrome-relay storage --tab <id> --domain example.com --type local
chrome-relay storage --tab <id> --domain example.com --type indexeddb --db <name>
```

#### 2.7c Console — already on the roadmap (was 2.3)

`Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded`. Buffered per-tab in the extension service worker (bounded ring, last 200 entries). `chrome-relay console --tab <id> --tail` for streaming.

#### 2.7d Performance / Lighthouse / Memory profile

These are real CDP domains (`Tracing`, `HeapProfiler`, `Profiler`) but the payloads are MB-sized traces that are hard for agents to reason about. Lower priority. If we add anything, it's `chrome-relay perf metrics --tab <id>` returning the small set of `PerformanceObserver` web-vitals (LCP, CLS, INP) — that's ~10 numbers, an agent can act on those, vs a 50 MB trace flame graph.

#### Buffering + storage rules across all of 2.7

The extension service worker is the natural buffer location. Service workers can be torn down by Chrome at any time, so the buffer must:

- be bounded per-tab (e.g., last 200 network entries, last 200 console entries)
- be wiped on tab close
- never persist to disk (privacy contract)
- be flushable on demand via the bridge

Implementation cost across all of 2.7: the network domain is ~400 LOC for capture+HAR; cookies+storage is ~150 LOC; console+exceptions ~120 LOC. Bigger than the other roadmap items but the agent value is correspondingly larger.

### 2.8 Value-aware verification — fix `read -i`

From `~/wiki/comparisons/browser-tool-verbosity-benchmark.md`:

> The weak point is verification. The follow-up `read -i` did not expose input values, so it confirms that fields still exist but not that values are correct. For form tasks, Chrome Relay needs a compact value-aware verification primitive.

This is a real bug, and it's tiny to fix. `chrome_read_page` with `interactiveOnly: true` should include `value` for inputs, `checked` for checkboxes, `selected` for `<option>`s, `aria-pressed` for toggles. We return a `state` field per interactive node.

```
chrome-relay read --tab <id> -i
# now returns: { selector: '#project-name', role: 'textbox', value: 'demo-worker' }
```

That alone halves the round-trips for form-fill verification. Implementation cost: ~30 LOC in the in-page snapshotter.

### 2.9 Network capture → replay — the "next gear"

This is the wiki vision (`network-api-discovery-for-browser-agents.md`): once chrome-relay can see network traffic (2.7a), it can offer agents a higher gear.

The shape, from the wiki:

```
1. agent intent
2. chrome-relay capture start --intent "find the search endpoint behind this dashboard"
3. agent does the UI action ONCE (click, fill, submit)
4. chrome-relay capture summarize       # returns 1-2 candidate routes, not raw HAR
5. chrome-relay capture replay --route <id> --params {...}
6. (optional) chrome-relay capture save --route <id> --as "search-users"
```

The agent now has a reusable typed tool instead of "click → fill → screenshot → wait → read" every time. For repeated workflows the token economics flip by 10-100×.

The wiki says: **never dump raw HAR into the model.** Capture locally, redact locally, return summaries only. Two products that nail this pattern are Integuru (enterprise) and rtrvr/Rover (developer-facing). chrome-relay would own the *discovery* end of that loop; the *compile-to-tool* end can stay with `printing-press`.

This is a bigger feature (multi-week, multiple components) and should land after 2.7a (network capture) gives us the raw substrate. But it's the most strategically important roadmap item — it's how chrome-relay becomes irreplaceable for repeated SaaS workflows, not just one-off browse-and-click.

---

## 3. Non-goals — what we should *not* try to do

These are categories where someone else is better positioned and our energy is better spent sharpening section 2.

- **Performance traces, Lighthouse, heap snapshots.** Google's Chrome DevTools MCP owns this; we shouldn't compete.
- **A managed Chromium of our own.** That's OpenClaw's category. Our value is the *user's real* Chrome session with their cookies and extensions.
- **Productized chat UX inside the extension.** Anthropic owns this with Claude in Chrome. We are the substrate, not a chat product.
- **Generic "browser as desktop automation".** Computer Use covers app-level UI. We are specifically the browser.

(The comparison detail to back this up lives in `~/wiki/comparisons/claude-in-chrome-vs-chrome-devtools-mcp.md` and `~/wiki/comparisons/browser-tool-io-and-agent-loops.md`. Not duplicating the tables here.)

---

## 4. Recommended sequence

Cheapest first, biggest user-visible delta per afternoon:

1. **2.8 Value-aware `read -i`** — ~30 LOC, ships today. Single biggest agent-side fix per line of code.
2. **2.2 Viewport emulation** — ~80 LOC + presets. Closes the responsive-bug blind spot we just hit on the autark dashboard.
3. **2.3 Region screenshots** — ~60 LOC. Saves 10× on tokens for every screenshot going forward.
4. **2.1 Groups** — ~150 LOC. Unlocks parallel autark hypotheses.
5. **2.7c Console + 2.7a Network capture (read-only)** — ~500 LOC total. The single largest agent-debugging upgrade.
6. **2.4 + 2.5 A11y tree + smart resolver** — ~400 LOC total. The token-economics moonshot — every page interaction gets cheaper.
7. **2.6 Screencast / frame strip** — ~300 LOC. Sub-second motion capture for animation verification.
8. **2.9 Network capture → replay** — the multi-week strategic bet. Lands after 2.7a gives us the raw substrate.

The thread tying these together: each one is a thin layer over a CDP primitive we already use, and each one closes a gap the user can feel within a single agent session. If we ship 1-7 over the next few weeks, chrome-relay's value prop becomes "the only browser bridge that gives you a11y semantics, sub-second motion capture, structured network logs, parallel windows, real-device viewports, *and* the user's actual logged-in session — all from a CLI."

That's the zero-reasons-to-switch surface area we want.
