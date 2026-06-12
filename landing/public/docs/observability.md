# Observability

> Console, network, screenshots, screencast — what the page did, not just what it looks like.


Debugging a web app through an agent means the agent needs what *you'd* open DevTools for. Chrome Relay buffers it per tab and serves it on demand.

## Console

```sh
chrome-relay console read --tab 42
chrome-relay console read --tab 42 --level error,warn
chrome-relay console read --tab 42 --since 1718200000000 --limit 50
chrome-relay console clear --tab 42
```

`console.log/info/warn/error/debug` plus uncaught page exceptions, in a per-tab ring buffer (last 200 entries, capped at 256 KB). Each entry: level, text, timestamp, source URL, line, stack.

The debugging pattern that earns its keep — plant a listener, act, then read what fired:

```sh
chrome-relay js --tab 42 "
  ['pointerdown','mousedown','click'].forEach(t =>
    document.addEventListener(t, e => console.log(t, e.target.tagName, e.target.className), {capture:true}));
  return 'listening'"
chrome-relay click @e12
chrome-relay console read --tab 42
```

A click that "succeeded but nothing happened" stops being a mystery.

## Network

```sh
chrome-relay network read --tab 42                       # request/response metadata
chrome-relay network read --tab 42 --url "/api/" --method POST
chrome-relay network read --tab 42 --status failed       # buckets: ok|redirect|client_error|server_error|failed
chrome-relay network body --tab 42 --request-id <id>     # fetch a response body on demand
chrome-relay network har --tab 42 -o session.har         # full HAR export
chrome-relay network clear --tab 42
```

Per-tab ring buffer (200 entries, 512 KB, metadata only — bodies fetched on demand because they're big and usually unneeded). Each entry: URL, method, status, mime, headers, timings, sizes, cache/service-worker flags.

Caveat worth knowing: Chrome evicts response bodies aggressively — `network body` on a request older than ~30 seconds may fail. Read bodies soon after the request, or capture a HAR while it's fresh.

## Screenshots

```sh
chrome-relay screenshot --tab 42 -o shot.png                 # background tabs fine
chrome-relay screenshot --tab 42 --full -o page.png          # beyond the viewport
chrome-relay screenshot --tab 42 --selector ".card" --padding 8 -o card.png
chrome-relay screenshot --tab 42 --max-edge 800 -o small.png # downscale for vision models
```

Use [snapshots](/docs/snapshots/) to *act* and screenshots to *verify* — text is cheap, pixels are proof. Take one before anything irreversible (form submit, send, delete).

## Screencast

```sh
chrome-relay screencast start --tab 42 --quality 80 --max-width 900
chrome-relay hover @e12       # the micro-interaction you're capturing
chrome-relay screencast stop --tab 42 --out /tmp/rec --gif
```

Paint-driven frame capture — it sees CSS transitions, fade-ins, and hover states that screenshot polling misses. Two constraints: the tab must be **active** (Chrome doesn't paint background tabs), and `--gif`/`--mp4` stitching needs ffmpeg on PATH (fails with `external_dependency_missing` if absent, or pass `--allow-missing-ffmpeg` to keep the raw frames). Consecutive identical frames are deduped by hash before stitching.

## What stays on your machine

All of it. Buffers live in the extension's memory, capped, per tab, dropped when the tab closes. Nothing is uploaded anywhere — there is nowhere to upload to.
