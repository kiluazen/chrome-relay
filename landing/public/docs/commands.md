# Command reference

> Every command, its flags, and an example. `--help` on any command is always authoritative.


Global targeting: most commands accept `-t/--tab <id>`, `--workspace <name>`, or `--group <name>` (exactly one). With none, the active tab is used — except ref actions, which target the ref's own tab.

## See the browser

| Command | Does |
|---|---|
| `tabs` | List all windows and tabs with ids, titles, URLs |
| `switch <tabId>` | Activate a tab (steals focus — that's its job) |
| `close <tabIds...>` | Close tabs |

## Navigate

```sh
chrome-relay navigate "https://example.com" --new        # background tab (default for --new)
chrome-relay navigate "https://example.com" --new --active  # foreground
chrome-relay navigate "https://example.com" --tab 42     # retarget an existing tab
```

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
| `--json` | structured `{ title, url, tabId, nodes, refs }` |

`read` / `ax` are deprecated aliases for `snapshot`.

## Act

```sh
chrome-relay click @e12                          # ref (preferred)
chrome-relay click 'button.save' --tab 42        # CSS selector
chrome-relay click --x 540 --y 320 --tab 42      # coordinates
chrome-relay fill @e14 "value"                   # input/textarea/select — atomic write
chrome-relay type "text" -s @e7                  # contenteditable/Lexical — trusted insertText
chrome-relay keys "Cmd+K" --tab 42               # single key or chord
chrome-relay hover @e3                           # pointer move only; fires :hover
chrome-relay click-ax --node 4837 --tab 42       # deprecated — raw backendNodeId
```

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

Paint-driven recording (catches CSS transitions and hover states). Requires the tab to be **active** — Chrome doesn't paint background tabs. With `--gif`/`--mp4` and ffmpeg on PATH, frames get stitched; consecutive identical frames are deduped.

## Observe

```sh
chrome-relay console read --tab 42 --level error,warn
chrome-relay network read --tab 42 --status failed
chrome-relay network body --tab 42 --request-id <id>
chrome-relay network har --tab 42 -o session.har
```

Per-tab ring buffers, last 200 entries each. Details: [Observability](/docs/observability/).

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
chrome-relay --workspace hypothesis-1 navigate "https://example.com" --new
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
| `self-reload` | restart the extension service worker (dev loop) |
| `call <tool> [json]` | raw pass-through to any internal tool |

## Output contract

Success prints JSON (or snapshot text) on stdout. Failure prints a human line plus a machine block on stderr and exits 1:

```json
{ "relayError": { "code": "stale_ref", "message": "...", "tool": "chrome_click_element", "details": {} } }
```

Branch on `code`. The full list: [Errors](/docs/errors/).
