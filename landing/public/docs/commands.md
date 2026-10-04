# Command reference

> Every command, its flags, and an example. `--help` on any command is always authoritative.


## 0.9 release status

The new browsing loop requires **CLI/native host 0.9.0 and extension 0.9.0**. The extension update is awaiting Chrome Web Store submission. Check `chrome-relay --version` and the `hostVersion` / `extensionVersion` from `chrome-relay profile list` before using it.

If your extension is still 0.8.2, CLI 0.9 rejects readiness navigation, composite `--snapshot`, settle and new recording starts before acting. Use `navigate <url> --new --wait none`, wait for the specific element or text you need, then take a separate snapshot. `chrome-relay update` refreshes the CLI/native host; Chrome updates each extension separately.


Global targeting: `--profile <label|idprefix>` first selects a connected browser/profile. Within it, most commands accept `-t/--tab <id>`, `--workspace <name>`, or `--group <name>` (exactly one). With none, the active tab is used — except ref actions, whose qualified token carries both its profile and tab.

## Choose a browser/profile (CLI 0.8+)

```sh
chrome-relay profile list
chrome-relay profile label work                       # one connected instance
chrome-relay --profile 3f2a profile label personal    # several: choose by ID prefix
chrome-relay --profile work tabs
chrome-relay profile unlabel personal
```

One connected instance routes implicitly. With several, an unscoped command fails `profile_ambiguous` and prints exact `--profile` choices; it never guesses. A qualified ref such as `@3f2a:e12` routes itself.

## See the browser

| Command | Does |
|---|---|
| `tabs` | List all windows and tabs with ids, titles, URLs |
| `switch <tabId>` | Rejected; use `--tab <id>` on the next command to keep working in the background |
| `close <tabIds...>` | Close tabs |

## Navigate

```sh
chrome-relay navigate "https://chrome-relay.kushalsm.com" --new             # background tab (default for --new)
chrome-relay navigate "https://chrome-relay.kushalsm.com" --tab 42          # retarget an existing tab
chrome-relay navigate "https://chrome-relay.kushalsm.com" --new --snapshot  # open, then print its refs
```

All navigation stays in the background. Legacy `--active` requests are rejected before navigation, including raw calls and batches.

`navigate` returns once the new document is usable (DOMContentLoaded), so the next `snapshot` reads the page you asked for, not the new tab's blank placeholder. The result reports `ready`, `readyState` and `waitedMs`; a slow page returns `ready: false` instead of failing, and a network error page returns `loadFailed: true`. `--wait load` also waits for images and other subresources, `--wait commit` only for the first byte, `--wait none` returns as soon as Chrome accepts the navigation. `--timeout <ms>` bounds the wait (default 10 s). If `ready` is false or `loadFailed` is true, wait for the required page state and take a fresh snapshot before acting. DOMContentLoaded does not guarantee app hydration.

## Read the page

```sh
chrome-relay snapshot --tab 42 -i        # the way — see /docs/snapshots/
chrome-relay snapshot --tab 42 -i -s "#main" -d 3 -u --json
```

| Flag | Does |
|---|---|
| `-i, --interactive` | only ref-bearing elements |
| `-d, --depth <n>` | truncate tree depth |
| `-s, --scope <css>` | subtree of the first match; refs outside it are never issued |
| `-u, --urls` | include link hrefs |
| `--diff` | print only what changed since this tab's previous snapshot (~100 tokens instead of a re-read; refs in the diff are current and clickable) |
| `--settle` | first wait (up to 2 s) for the page to stop changing |
| `--no-wait` | read mid-navigation instead of waiting for the pending document |
| `--json` | structured `{ title, url, tabId, nodes, refs }` |

A snapshot taken while a navigation is pending waits (up to 10 s) for the new document's DOMContentLoaded instead of describing the document being replaced. If the page is still loading at the deadline, the output says so on a `Loading:` line.

`read` / `ax` are deprecated aliases for `snapshot`.

## Wait

```sh
chrome-relay wait @e12                        # ref resolves and has a box
chrome-relay wait ".results" --tab 42         # selector exists and visible
chrome-relay wait --text "Welcome" --tab 42
chrome-relay wait --url "**/dashboard" --tab 42
chrome-relay wait --load networkidle --tab 42 # also: load | domcontentloaded
chrome-relay wait --fn "window.__READY" --tab 42
chrome-relay wait 1500                        # plain sleep
```

One condition per call; default timeout 10 s, capped at 25 s. On timeout the structured error includes the page's current state (url, readyState, whether the selector exists) — no follow-up probe needed.

## Get — one value, no snapshot

```sh
chrome-relay get text @e12
chrome-relay get value 'input[name="email"]' --tab 42
chrome-relay get attr @e7 href
chrome-relay get count ".result" --tab 42
chrome-relay get title --tab 42
chrome-relay get url --tab 42
```

Plain value on stdout, nothing else — built for `$(...)` substitution in scripts.

## Batch — N calls, one round-trip

```sh
chrome-relay batch '[
  {"name":"chrome_navigate","args":{"url":"https://chrome-relay.kushalsm.com","newTab":true}},
  {"name":"chrome_wait","args":{"load":"load"}},
  {"name":"chrome_snapshot","args":{"interactiveOnly":true}}
]'
cat commands.json | chrome-relay batch --stdin
```

Sequential execution in the extension, bail-on-error by default (`--no-bail` to continue). Uses wire tool names. Amortizes process startup and the bridge hop across N actions; nested batches are rejected.

## Act

```sh
chrome-relay click @e12                          # ref (preferred)
chrome-relay click @e12 --snapshot               # click, wait for the page to react, print it
chrome-relay click @e12 --no-wait                # skip the delayed-navigation check
chrome-relay click 'button.save' --tab 42        # CSS selector
chrome-relay click --x 540 --y 320 --tab 42      # coordinates
chrome-relay fill @e14 "value"                   # input/textarea/select — atomic write
chrome-relay type "text" -s @e7                  # contenteditable/Lexical — trusted insertText
chrome-relay keys "Cmd+K" --tab 42               # single key or chord
chrome-relay hover @e3                           # pointer move only; fires :hover
chrome-relay click-ax --node 4837 --tab 42       # deprecated — raw backendNodeId
```

`--snapshot` on `navigate`, `click`, `fill`, `type` and `keys` prints the action's result, then an interactive snapshot of the tab it acted on: one command instead of two. For input actions it first waits for the page to stop reacting (no recent request in flight and the DOM quiet briefly, at most 2 s), or for the navigation the input started. The observer runs in an isolated world, so page scripts cannot see it.

`click --no-wait` still dispatches trusted input and checks for immediate navigation, but skips the default 120 ms grace period for delayed navigation. Use it when the next step explicitly verifies the result, for example `wait --text "Saved" --tab 42` or `snapshot --tab 42 --diff`. Its response includes `navigationCheck: "immediate"`; the absence of `navigated` does not rule out later navigation. In a batch, set `waitForNavigation: false` on the click's wire args and follow with the appropriate wait. Older extensions ignore this field and retain their usual delay.

## Agent cursor

```sh
chrome-relay cursor          # { "enabled": true }
chrome-relay cursor off      # stop drawing it, for every tab of this profile
chrome-relay cursor on
```

Your real mouse never moves. Instead, each click, hover, fill and type draws an arrow in that tab: it glides to the target, pulses on click, wiggles while the agent is between commands, and fades after 15 s idle. It does not wait for its animation before acting. It runs in an isolated world inside a closed shadow root, so page scripts cannot access its API or shadow tree, but can detect the host element. Snapshots and hit tests ignore it, and after it first appears its movement causes no DOM mutations the page can observe. `screenshot` hides it; screencast recordings keep it.

## Evaluate JavaScript

```sh
chrome-relay js --tab 42 "return document.title"
chrome-relay js --tab 42 "const r = await fetch('/api/me'); return await r.json()"
```

MAIN world, async IIFE, top-level `await` works, `return` sends the value back. Page globals and framework internals are reachable.

## Capture

```sh
chrome-relay screenshot --tab 42 -o out.png            # works on background tabs
chrome-relay screenshot --tab 42 --full -o page.png    # beyond the viewport
chrome-relay screenshot --tab 42 --selector "header" --padding 8 -o hdr.png
chrome-relay screenshot --tab 42 --bbox 0,0,1280,80 -o region.png
chrome-relay screenshot --tab 42 --max-edge 800 -o small.png
```

Region screenshots are ~10× cheaper in tokens than full-tab when you only need one component.

```sh
chrome-relay screencast start --tab 42 --quality 80 --max-width 900
# ...drive the interaction...
chrome-relay screencast stop --tab 42 --out /tmp/rec --gif
```

Records sampled screenshots in the background at up to 15fps. It never selects the tab; changes between samples may be missed. `--every-nth N` multiplies the sampling interval. With `--gif`/`--mp4` and ffmpeg on PATH, frames get stitched; consecutive identical frames are deduped.

## Observe

```sh
chrome-relay console read --tab 42 --level error,warn
chrome-relay network read --tab 42 --status failed
chrome-relay network body --tab 42 --request-id <id>
chrome-relay network har --tab 42 -o session.har
```

Per-tab ring buffers, last 200 entries each. Details: [Observability](/docs/observability/).

## Upload (CLI and extension 0.8+)

```sh
chrome-relay upload set --selector 'input[type=file]' --tab 42 ./cv.pdf
chrome-relay upload choose --click-ref @3f2a:e4 ./cv.pdf
chrome-relay upload drop --selector '.dropzone' --tab 42 ./avatar.png
```

`set` targets a file input directly, including hidden inputs. `choose` intercepts the browser picker before clicking, so no OS dialog appears. `drop` dispatches drag-enter/over/drop events. Chrome reads filesystem paths directly; there is no bridge upload or size cap. Enable “Allow access to file URLs” for Chrome Relay in the browser's extension settings; `doctor` reports the toggle per profile.

## Emulate

```sh
chrome-relay viewport preset iphone-14 --tab 42
chrome-relay viewport set --width 390 --height 844 --dpr 3 --mobile --touch --tab 42
chrome-relay viewport clear --tab 42
chrome-relay viewport list
```

## Multi-agent

```sh
chrome-relay workspace create hypothesis-1     # a named Chrome window
chrome-relay --workspace hypothesis-1 navigate "https://chrome-relay.kushalsm.com" --new
chrome-relay group create research --color blue --tab 42   # native tab groups
```

Details: [Workspaces](/docs/workspaces/).

## Maintain

| Command | Does |
|---|---|
| `install` | register the native host for every detected browser |
| `doctor` | validate the whole chain end to end |
| `update` | update the CLI, print what changed (JSON) |
| `release-notes --since <ver>` | the changelog, agent-readable |
| `skills get core` | print the agent playbook, version-matched to the binary |
| `self-reload` | restart the extension service worker (dev loop) |
| `call <tool> [json]` | raw pass-through to any internal tool |

## Output contract

Success prints JSON (or snapshot text) on stdout. Failure prints a human line plus a machine block on stderr and exits 1:

```json
{ "relayError": { "code": "stale_ref", "message": "...", "tool": "chrome_click_element", "details": {} } }
```

Branch on `code`. The full list: [Errors](/docs/errors/).
