# Issues found while testing chrome-relay 0.3.1

Tested against the globally-installed `chrome-relay` CLI on 2026-05-16, exercising every
new surface from boundaries.md §2.1–2.8 against `https://chrome-relay.kushalsm.com`.

Note on versions: `chrome-relay --version` reports `0.2.3`, but the actually installed
package is `0.3.1` (see #11 below) — the binary I tested behaves like 0.3.x.

What follows is what either broke outright or felt sharp enough to write down, sorted by
"would bite an agent immediately" → "papercut".

---

## 1. `viewport set` fails unless you pass `--touch`

Repro:

```
chrome-relay viewport set --tab <id> --width 1280 --height 800
→ {"code":-32602,"message":"Touch points must be between 1 and 16"}
```

The same call with `--touch` succeeds. So the failure is the *non-touch* path — somewhere
we're sending `Emulation.setTouchEmulationEnabled` (or the `maxTouchPoints` field inside
`setDeviceMetricsOverride`) with `0`, which Chrome rejects.

Why this matters: most agents reach for `viewport set --width X --height Y` first (it reads
like the most basic call). The error message is opaque ("touch points") and unrelated to
what the agent asked for. Either:

- omit the touch-emulation call entirely when `--touch` isn't passed, or
- pass `maxTouchPoints: 1` only when `hasTouch: true`.

`viewport preset iphone-14` and `desktop-1280` worked fine, so the bug is isolated to the
`set` codepath.

## 2. Mobile-DPR screenshots blow past the image ingestion cap

`viewport preset iphone-14 --tab X` sets DPR=3. The next `screenshot --tab X -o out.png`
saves a ~1 MB PNG roughly 1170×2532 px. Most agent image APIs (including the one I'm
running under) cap images around 2000 px on the longer edge, so the screenshot comes back
unreadable.

I had to manually `sips -Z 1600` to bring it down.

Two reasonable fixes:

- `screenshot --max-edge <px>` that downscales after capture.
- Or have `viewport preset` default DPR to 2 when no `--dpr` is passed. iPhone-14 is DPR=3
  in real life but agents almost never need that much detail.

Quietly capping at e.g. 1600 px would dodge the issue without adding a flag.

## 3. `network har` exports without bodies — silently

`chrome-relay network har` returns a well-formed HAR 1.2 file. Every
`entry.response.content` has `mimeType` and `size`, but `text` is empty. The body is
fetchable only via `chrome-relay network body <requestId>`, and only within ~30 s before
Chrome GCs it.

So if I `network har > capture.har` and then later try to inspect or replay bodies, I have
metadata-only. For most use cases (debugging API shapes, recording for replay) this
defeats the point of HAR.

Suggested fixes:

- `network har --with-bodies` flag that fetches every body before writing the file.
- Or eager-buffer responses up to N KB by default (json/text/html) — boundaries.md §2.9
  already gestures at this.

At minimum: print a stderr warning at the top of HAR output that bodies are not included.
Right now this is a silent footgun.

## 4. `network read` returns the extension's own `chrome-extension://` URLs

After navigating the landing page, `network read` returned 10 entries, one of which was:

```
GET 200 - chrome-extension://liecbddmkiiihnedobmlmillhodjkdmb/js/recordConsoleEvents.js
```

That's chrome-relay itself loading its own console recorder. It should be filtered out of
user-facing captures by default — agents will waste tokens on it and it'll show up in HAR
exports as noise. A simple `url.startsWith('chrome-extension://')` filter at the buffer
edge handles it.

## 5. `network body` dumps the entire body with no `--head` / `--max-bytes`

Fetching the body for the landing-page HTML returned a 30 KB+ blob into the agent's context
window with no flag to truncate. For minified JS bundles or large API responses this will
blow up the context fast.

`--head <bytes>` or `--max <bytes>` (matching `head -c`) would be ideal. Even better:
default to first 8 KB and require `--full` to get the rest.

## 6. `network` top-level help advertises flags that only work on `network read`

`chrome-relay network --help` shows examples like:

```
chrome-relay network --tab 123 --filter api.example.com
chrome-relay network --tab 123 --status failed
chrome-relay network --tab 123 --method POST
```

But those flags actually live on `network read`. Empirically `chrome-relay network --tab 123`
works (and is treated as `network read --tab 123`), but the `--filter` / `--status` /
`--method` flags only parse if you spell out `read`. So the help is teaching agents an
invocation that mostly works but silently ignores the filters.

Fix: either lift the filter options up to the top-level `network` command, or rewrite the
examples to say `network read --filter ...`.

## 7. `tabs list` rejects the verb form

```
chrome-relay tabs list
→ error: too many arguments for 'tabs'. Expected 0 arguments but got 1.
```

You have to say `chrome-relay tabs` with no subverb. Every other multi-command (`group
list`, `viewport list`, `network read`) takes a verb, so this is inconsistent. Either
accept `tabs list` as an alias, or document the bare `tabs` form more loudly in the help.

## 8. `chrome-relay --version` reports 0.2.3 but installed package is 0.3.1

```
$ chrome-relay --version
0.2.3
$ cat ~/Library/pnpm/global/5/.pnpm/chrome-relay@0.3.1/node_modules/chrome-relay/package.json | jq .version
"0.3.1"
```

There's a hardcoded version string in the CLI source that didn't get bumped along with
`packages/cli/package.json`. Confused me for the better part of an hour while I tried to
work out which feature set I should be testing — eventually I had to grep the install
path to confirm. Bump `program.version(...)` from the package.json instead of hardcoding,
or wire it into the build.

## 9. `console` entries from CLI-emitted `js()` calls have `url=""`

Minor. When chrome-relay's own `js` call triggers `console.log("…")`, the captured entry
shows `url: ""`, `line: 0`, `column: <eval offset>`. That's technically correct (it *is*
an eval) but gives no stack-trace breadcrumb for an agent to correlate the log with the
call site. Nothing obvious to do here other than note it.

---

## What's *not* broken (positively surprised)

A few items I expected to find friction with and didn't:

- **`read -i` is value-aware** — confirmed end-to-end. After filling the contact input,
  `read -i` returned the element with
  `state: { value: 'test@example.com', placeholder: ..., required: true }`. §2.8 shipped.
- **`read -i` recall matches `ax -i` on this page** — both returned 8 interactive elements
  (logo, Add-to-Chrome, Copy, contact input, Send, three footer links). I had a stale
  earlier test that showed only 3 elements; could not repro after clearing viewport state.
- **Region screenshots (`--selector .contact-form`) are clean** — bounding box was tight
  and the output crisp; this is exactly the §2.3 "10× cheaper than full-page screenshot"
  payoff.
- **Groups work cleanly** — `group create relay-test --url about:blank`, then
  `chrome-relay --group relay-test navigate https://example.com` and
  `--group relay-test js "return document.title"` both did the right thing. `group close`
  cleaned up.
- **`click-ax --node` works without a CSS selector** — clicked the Copy button at the
  reported center coords; the doc warning about stale ids reads correct.

---

## Summary, ranked by what I'd fix first

1. **#1 viewport-set touch crash** — fully blocks the obvious agent call.
2. **#2 mobile-DPR screenshot size** — a single mobile screenshot already breaks downstream
   agent pipelines.
3. **#3 + #4 + #5 network HAR / body ergonomics** — together they're what makes the
   network surface trustworthy enough to actually rely on. Silent missing bodies in HAR
   is the loudest of the three.
4. **#6 + #7 + #8 help / version inconsistencies** — paper cuts, but `--version` being
   wrong cost me real time and the others will cost agents tokens.

Nothing in here threatens the architecture; all of it is polish on already-shipped surface
area.
