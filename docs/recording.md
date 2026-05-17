# Recording & Interaction Observability

Two primitives let agents (and humans) capture what actually happened on a
page, at the fidelity needed to debug *how* an interaction felt — not just
that it returned `{ clicked: true }`.

| Tool | Purpose | Best for |
|------|---------|----------|
| `chrome_hover` | Dispatch `mouseMoved` at an element (or `x,y`) without clicking | Pre-click states: tooltips, dropdown openers, focus rings, `:hover` styles |
| `chrome_screencast` | Wraps CDP `Page.startScreencast` / `stopScreencast` | Paint-accurate recording: transitions, fade-ins, animation mid-states |

These pair with the existing `chrome_screenshot` (a single `Page.captureScreenshot`)
which is still the right tool for evidence-style "what does the page look like
right now" checks.

## When to reach for which

```
need a single still of current state?               → chrome_screenshot
need to verify a hover/tooltip appeared at all?     → chrome_hover  + chrome_screenshot
need to debug whether a CSS transition played?      → chrome_screencast
need to capture a multi-step interaction faithfully? → chrome_screencast
```

## Active-tab requirement (the honest matrix)

| Primitive | Backgrounded tab | Reason |
|-----------|------------------|--------|
| `chrome_screenshot` | **Works** | CDP forces a paint when you call `Page.captureScreenshot`. Verified: inject a DOM change into a backgrounded tab, screenshot immediately, the change is present. |
| `chrome_hover` | Works | Input dispatch doesn't care about visibility. |
| `chrome_screencast` | **Does not work** (returns 0 frames) | Screencast is paint-driven. Chrome doesn't run paint loops on backgrounded tabs, so there are no paint events to push down the CDP channel. |

Practical consequence for the workspace/tab-group story:
- Parallel agents in their own workspaces *can* still take screenshots and
  drive interactions without stealing user focus.
- They *cannot* capture animated recordings without activating the tab. If
  you want a screencast, call `chrome-relay switch <tabId>` first.

## chrome_hover

Dispatches `Input.dispatchMouseEvent` of type `mouseMoved` at either a CSS
selector's element center, or explicit `x,y` page coordinates. Fires
`:hover`, `:focus-within`, JS `mouseover` handlers, tooltip pop-ins, dropdown
openers — everything that previously required a click to trigger.

```bash
chrome-relay hover 'button[aria-label="Install runner"]'
chrome-relay hover --x 1327 --y 827
chrome-relay hover --tab 460137601 '.nav-item:nth-child(3)'
```

Pair with `screencast` to capture the hover state actually rendering:

```bash
chrome-relay screencast start --tab $T
chrome-relay hover --tab $T 'button.help-trigger'
sleep 0.4                      # let the tooltip fade in
chrome-relay screencast stop --tab $T --out /tmp/rec --gif
```

## chrome_screencast

Wraps the CDP screencast pipeline:

- `Page.startScreencast` — attaches the extension as a screencast subscriber.
- The compositor pushes a `Page.screencastFrame` event for every paint.
- The service worker buffers frames per tab, ACKs each one (mandatory — omit
  the ACK and CDP throttles you down to nothing within a second or two).
- `Page.stopScreencast` ends the stream; `screencast stop` returns the buffer.

### CLI

```bash
chrome-relay screencast start --tab $T \
  [--format jpeg|png] \
  [--quality 80] \
  [--max-width 1200] \
  [--max-height 800] \
  [--every-nth 1]

chrome-relay screencast stop --tab $T \
  --out /tmp/recording \
  [--gif] [--mp4] [--fps 14] \
  [--no-dedupe]
```

`--out` is a directory; frames are written as `frame_NNNN.jpg`. If `--gif`
or `--mp4` is passed and `ffmpeg` is on PATH, a stitched file is written
next to the directory (`/tmp/recording.gif`, `/tmp/recording.mp4`).

### Dedupe (default on)

Paint-driven capture means even "static" pages trickle frames the user
doesn't perceive as changing — cursor blink, focus-ring fades, idle
`requestAnimationFrame` loops. Without dedupe, 5-10 seconds of recording
can be 80% identical frames.

`screencast stop` runs a post-capture dedupe step:

1. SHA-256 each written JPEG.
2. Drop frames whose hash matches the immediately preceding frame.
3. Renumber the surviving frames consecutively (so ffmpeg's
   `image2 frame_%04d.jpg` reader picks them all up).

Pass `--no-dedupe` to keep every raw frame (useful when you need timing
fidelity for analysis — durations between paint events become meaningful).

### Defaults

- JPEG quality 80 (favors precision over file size; the agent can downscale
  on read if needed).
- `everyNthFrame=1` — keep every compositor frame.
- Dedupe on.

## Self-observability pattern (for agents)

A common loop:

```bash
# 1. Make sure the tab is active (screencast needs paint).
chrome-relay switch $T

# 2. Start recording.
chrome-relay screencast start --tab $T --quality 80

# 3. Drive the interaction.
chrome-relay hover --tab $T '.menu-button'
sleep 0.3
chrome-relay click --tab $T '.menu-button'
sleep 0.5
chrome-relay click --tab $T '.menu-item[data-id="export"]'

# 4. Stop and dedupe.
chrome-relay screencast stop --tab $T --out /tmp/rec --gif

# 5. The agent reads back a few frames to verify what happened.
ls /tmp/rec                    # ~6-12 distinct frames after dedupe
# Read frame_0001.jpg (start state)
# Read frame_0006.jpg (mid-transition — confirms menu animated open)
# Read frame_0012.jpg (final state)
```

The agent doesn't need to inspect every frame. After dedupe, each
remaining frame represents an actual visual state change — making it cheap
to grep for "did the modal open" or "did the dropdown ever render."

## File-size guidance

At default settings (jpeg q=80, full-viewport on a 1200px-wide tab):

| Duration | Frames (pre-dedupe) | Size pre-dedupe | Size after dedupe |
|----------|---------------------|-----------------|-------------------|
| 5s, static interaction | ~60 | ~2-3 MB | ~200-400 KB |
| 10s, animated demo | ~140 | ~4-6 MB | ~1-2 MB |

If memory pressure matters (long captures), pass `--max-width 900` to
downscale at capture time. The extension's service-worker buffer is bounded
only by browser heap.

## Caveats

- The screencast comment used to claim "works on backgrounded tabs." It
  does not. Documented above.
- The screencast buffer lives in the extension service worker. If Chrome
  evicts the SW mid-capture (rare but possible on long idle), the buffer is
  lost. Don't run captures longer than ~60s without testing for your case.
- `Page.captureScreenshot` and `Page.startScreencast` cannot run
  simultaneously on the same target — if you start a screencast, the
  screenshot tool on that tab will fail until you stop it.
