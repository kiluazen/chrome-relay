# Issues found while testing chrome-relay

Originally written 2026-05-16 against 0.3.1. Re-tested 2026-05-17 against
`chrome-relay@0.3.2` after `42fa2a7` ("fix: 8 issues from docs/issues.md"),
then once more against `chrome-relay@0.3.3` which closes both remaining items.

## Resolved in 0.3.3

- **#3 (regression) `network har --with-bodies`** — bodies are now actually
  embedded. The previous build fetched them via `Network.getResponseBody` but
  the entry-merge step read the wrong field (`text` instead of `body`) and
  silently dropped the payload. The Map type was lying about its shape, which
  hid the bug from `tsc`. Type and field name realigned to `body`. Verified
  live: an `https://example.com` HAR comes back with `entry.response.content.text`
  populated (528 bytes of HTML) and `bodyState: "fetched"`.
- **#9 console attribution for `js()`-emitted logs** — inline-eval frames (the
  ones produced by `chrome-relay js …`) used to come through with `url: ""`.
  They now get tagged `url: "<chrome-relay:js>"` so an agent can visually tell
  its own injection apart from real page-script logs.

## Resolved in 0.3.2

- **#1 `viewport set` touch crash** — `viewport set --width X --height Y` now works without
  `--touch`. Verified.
- **#2 mobile-DPR screenshot size** — `screenshot --max-edge <px>` lands. iPhone-DPR=3
  captures (1170×2532) come back as 739×1600 with `--max-edge 1600`.
- **#4 `chrome-extension://` noise in captures** — filtered at the buffer edge. Fresh
  navigation returns 0 own-extension entries (was 1/10).
- **#5 `network body` truncation** — defaults to first 8 KB with `truncated: true`,
  `--head <bytes>` caps explicitly, `--full` returns the entire body.
- **#6 top-level `network --filter / --status / --method / --limit`** — lifted to the
  parent command. `network --filter cloudflare`, `--method POST`, `--limit 2` all honored.
- **#7 `tabs list` verb** — accepted as alias for the bare `tabs` form.
- **#8 `--version` drift** — `chrome-relay --version` now reads from package.json at
  build time. Reports the installed version.

## What's still left

Nothing.
