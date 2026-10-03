# Background recording

`chrome_screencast` records sampled screenshots without selecting the tab,
raising its window, or moving the user's pointer. It uses
`Page.captureScreenshot`, which can capture background tabs even when their
compositor stops emitting screencast events.

Use a single `chrome_screenshot` for a still image. Use a recording to inspect
changes across a multi-step interaction. Sampling may miss brief transitions;
it does not promise every compositor frame.

```sh
chrome-relay screencast start --tab 42 --quality 80 --max-width 900
chrome-relay hover --tab 42 '.menu-button'
chrome-relay click --tab 42 '.menu-button'
chrome-relay screencast stop --tab 42 --out /tmp/recording --gif
```

Do not switch to the target tab. `switch` and navigation with `--active` are
rejected; target the tab with `--tab` throughout the interaction.

Capture starts with one screenshot, then samples at up to 15fps. Slow captures
reduce the effective frame rate, and captures never overlap. `--every-nth N`
multiplies the base 67ms interval by N. Each frame has its actual capture
timestamp and encoded image dimensions. `--max-width` and `--max-height` limit
the dimensions while preserving aspect ratio. JPEG quality defaults to 80;
`--format png` is also supported. Start and stop responses report
`mode: "sampled"`.

Frames stay in the extension service worker until stop. Stop cancels the
sampling timer, waits for any in-flight capture, and returns buffered frames.
Closing the tab also cancels capture. If sampling fails after start, stop
returns the captured frames and a `captureError` message. The CLI saves partial
frames when `--out` is provided, then exits with an error instead of stitching
an incomplete recording. A failure to capture
the initial frame fails the start call.

`--out` writes frames to a directory. Consecutive identical frames are deduped
by hash unless `--no-dedupe` is passed. `--gif` and `--mp4` require ffmpeg on PATH;
missing ffmpeg fails with `external_dependency_missing` unless
`--allow-missing-ffmpeg` is passed. Stitching uses the requested `--fps` (default
15), rather than reconstructing the actual capture timestamps.

Keep recordings short: the frame buffer is limited by the browser heap, and
service-worker restart loses the recording. Downscaling reduces memory use.
The screenshot tool can also run while a sampled recording is active.
