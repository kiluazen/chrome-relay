// screenshot / read / ax / click-ax / screencast — visual + structural
// capture commands.

import { writeFileSync } from "node:fs";
import { tabOpt, type CommandContext } from "./shared.js";
import { callTool } from "../client/call.js";

export function registerCapture(ctx: CommandContext): void {
  const { program, baseArgs, run } = ctx;

  tabOpt(
    program
      .command("screenshot")
      .description("Capture a screenshot of any tab without activating it.")
      .option("--full", "capture beyond the viewport (full page)")
      .option("--bbox <rect>", "capture a region: 'x,y,width,height' (pixels)")
      .option("--selector <css>", "capture the bounding box of a CSS selector")
      .option("--padding <px>", "pixels of padding around --selector region", (v) => Number(v))
      .option("--max-edge <px>", "downscale so longer edge ≤ this many pixels (no default; opt-in)", (v) => Number(v))
      .option("-o, --out <path>", "save image to path (base64 PNG decoded)")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay screenshot -o active-tab.png
  chrome-relay screenshot --tab 123456789 -o evidence.png
  chrome-relay screenshot --tab 123456789 --full -o full-page.png
  chrome-relay screenshot --tab 123456789 --bbox 0,0,1280,80 -o header.png
  chrome-relay screenshot --tab 123456789 --selector "header" -o header.png
  chrome-relay screenshot --tab 123456789 --selector ".card:nth-child(3)" --padding 8 -o card.png

Region screenshots (--bbox / --selector) are ~10x cheaper in tokens than a
full-tab screenshot when an agent only needs to see one component.
`
      )
  ).action(async (opts) => {
    const args: Record<string, unknown> = {};
    Object.assign(args, baseArgs(opts));
    if (opts.full) args.fullPage = true;
    if (opts.bbox) args.bbox = opts.bbox;
    if (opts.selector) args.selector = opts.selector;
    if (typeof opts.padding === "number") args.padding = opts.padding;
    if (typeof opts.maxEdge === "number") args.maxEdge = opts.maxEdge;
    try {
      const result = await callTool("chrome_screenshot", args);
      if (opts.out && result && typeof result === "object") {
        const data = (result as { dataUrl?: string; data?: string }).dataUrl
          ?? (result as { data?: string }).data;
        if (typeof data === "string") {
          const b64 = data.includes(",") ? data.split(",")[1] : data;
          writeFileSync(opts.out, Buffer.from(b64, "base64"));
          process.stdout.write(`Saved screenshot to ${opts.out}\n`);
          return;
        }
      }
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.message : String(error)) + "\n"
      );
      process.exit(1);
    }
  });

  tabOpt(
    program
      .command("read")
      .description("Extract page structure and interactive elements.")
      .option("-i, --interactive", "return only interactive elements")
  ).action(async (opts) => {
    const args: Record<string, unknown> = {};
    Object.assign(args, baseArgs(opts));
    if (opts.interactive) args.interactiveOnly = true;
    await run("chrome_read_page", args);
  });

  // ---------- ax (§2.4 — accessibility tree) ----------
  tabOpt(
    program
      .command("ax")
      .description("Extract the accessibility tree — ~30× smaller than `read` and more semantic.")
      .option("-i, --interactive-only", "filter to actionable roles (button, link, textbox, ...)")
      .option("--root <role>",           "start from the first node matching this role (e.g. 'main')")
      .option("--include-subframes",     "walk subframes too (default: top frame only)")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay ax --tab 123
  chrome-relay ax --tab 123 --interactive-only
  chrome-relay ax --tab 123 --root main --interactive-only

Notes:
  Each node carries an "id" — that's the backendDOMNodeId. Pass it to
  \`chrome-relay click-ax --node <id>\` to click without a CSS selector.
`
      )
  ).action(async (opts) => {
    const args: Record<string, unknown> = baseArgs(opts);
    if (opts.interactiveOnly)  args.interactiveOnly = true;
    if (opts.root)             args.rootRole = opts.root;
    if (opts.includeSubframes) args.includeSubframes = true;
    await run("chrome_ax", args);
  });

  tabOpt(
    program
      .command("click-ax")
      .description("Click an element by its backendDOMNodeId from a previous `ax` call.")
      .requiredOption("--node <id>", "backendDOMNodeId from `chrome-relay ax`", (v) => Number(v))
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay click-ax --tab 123 --node 456

Notes:
  Throws explicitly if the node id is stale (page mutated since you called
  \`ax\`). Re-run \`ax\` and pass the fresh id.
`
      )
  ).action(async (opts) => {
    const args: Record<string, unknown> = baseArgs(opts);
    args.node = opts.node;
    await run("chrome_click_ax", args);
  });

  // ---------- screencast (Page.startScreencast / stopScreencast) ----------
  // Paint-driven JPEG frame capture. Catches CSS transitions, fade-ins,
  // hover tooltips — everything Page.captureScreenshot polling misses.
  // REQUIRES an active tab (Chrome doesn't paint backgrounded tabs).
  // CLI shape: start → returns immediately, stop → returns frames JSON or
  // writes them to disk + invokes ffmpeg if --out is given. Stop runs a
  // SHA-256 dedupe pass by default; pass --no-dedupe to keep raw frames.
  // See docs/recording.md.
  const screencast = program
    .command("screencast")
    .description("Record a tab via CDP (paint-driven). Requires an active tab.")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay screencast start --tab 123 --quality 80 --max-width 900
  # ... drive the interaction (hover, click, etc.) ...
  chrome-relay screencast stop --tab 123 --out /tmp/recording

  # The --out path becomes a directory of frame_NNNN.jpg files. If ffmpeg
  # is on PATH and --gif is also passed, an animated GIF is written next to
  # the frames at /tmp/recording.gif.

Notes:
  Frames buffer in the extension service worker. A 10-second capture at
  default settings (jpeg q=60, ~15fps, full viewport) lands ~2-3 MB.
  Pass --max-width to downscale and lighten the buffer.
  Each frame is base64 JPEG; the CLI decodes them when --out is given.
`
    );

  tabOpt(
    screencast
      .command("start")
      .description("Begin screencast capture on a tab.")
      .option("--format <fmt>", "jpeg | png (default jpeg)")
      .option("--quality <n>",  "jpeg quality 0-100 (default 80)", (v) => Number(v))
      .option("--max-width <px>",  "downscale; aspect preserved", (v) => Number(v))
      .option("--max-height <px>", "downscale; aspect preserved", (v) => Number(v))
      .option("--every-nth <n>",   "throttle: keep 1 in N frames (default 1)", (v) => Number(v))
  ).action(async (opts) => {
    const args: Record<string, unknown> = { action: "start" };
    Object.assign(args, baseArgs(opts));
    if (opts.format)                       args.format = opts.format;
    if (typeof opts.quality === "number")  args.quality = opts.quality;
    if (typeof opts.maxWidth === "number") args.maxWidth = opts.maxWidth;
    if (typeof opts.maxHeight === "number") args.maxHeight = opts.maxHeight;
    if (typeof opts.everyNth === "number") args.everyNthFrame = opts.everyNth;
    await run("chrome_screencast", args);
  });

  tabOpt(
    screencast
      .command("stop")
      .description("Stop the screencast and emit frames (or write to disk).")
      .option("-o, --out <dir>", "write frames as JPEGs into this directory (created if missing)")
      .option("--gif",            "after writing frames, ffmpeg them into <dir>.gif")
      .option("--mp4",            "after writing frames, ffmpeg them into <dir>.mp4")
      .option("--fps <n>",        "assumed framerate when invoking ffmpeg (default 15)", (v) => Number(v))
      .option("--no-dedupe",      "keep raw frames; default collapses consecutive identical frames via SHA-256")
  ).action(async (opts) => {
    const args: Record<string, unknown> = { action: "stop" };
    Object.assign(args, baseArgs(opts));
    try {
      const result = await callTool("chrome_screencast", args) as {
        frameCount: number;
        durationMs: number;
        frames: Array<{ data: string; timestamp: number; width: number; height: number }>;
      };
      if (!opts.out) {
        const { frames, ...summary } = result;
        process.stdout.write(JSON.stringify({ ...summary, framesOmitted: frames.length, hint: "pass --out <dir> to save" }, null, 2) + "\n");
        return;
      }
      const { mkdirSync, writeFileSync: wf, renameSync, unlinkSync } = await import("node:fs");
      const path = await import("node:path");
      const { createHash } = await import("node:crypto");
      mkdirSync(opts.out, { recursive: true });
      result.frames.forEach((f, i) => {
        const name = `frame_${String(i + 1).padStart(4, "0")}.jpg`;
        wf(path.join(opts.out, name), Buffer.from(f.data, "base64"));
      });
      process.stdout.write(`Wrote ${result.frames.length} frames to ${opts.out}\n`);

      // Dedupe: SHA-256 each frame, drop those whose hash matches the
      // previous one, renumber survivors so ffmpeg's image2 reader stays
      // happy. commander maps --no-dedupe to opts.dedupe === false.
      const dedupeOn = opts.dedupe !== false;
      if (dedupeOn && result.frames.length > 1) {
        const hashes = result.frames.map((f) =>
          createHash("sha256").update(Buffer.from(f.data, "base64")).digest("hex")
        );
        const kept: number[] = [];
        let prev = "";
        hashes.forEach((h, i) => {
          if (h !== prev) kept.push(i);
          prev = h;
        });
        const dropped = result.frames.length - kept.length;
        if (dropped > 0) {
          for (let i = 0; i < result.frames.length; i++) {
            const src = path.join(opts.out, `frame_${String(i + 1).padStart(4, "0")}.jpg`);
            try { unlinkSync(src); } catch { /* missing is fine */ }
          }
          kept.forEach((srcIdx, newIdx) => {
            const tmp = path.join(opts.out, `tmp_${String(newIdx + 1).padStart(4, "0")}.jpg`);
            wf(tmp, Buffer.from(result.frames[srcIdx].data, "base64"));
          });
          kept.forEach((_, newIdx) => {
            const tmp = path.join(opts.out, `tmp_${String(newIdx + 1).padStart(4, "0")}.jpg`);
            const final = path.join(opts.out, `frame_${String(newIdx + 1).padStart(4, "0")}.jpg`);
            renameSync(tmp, final);
          });
          process.stdout.write(`Deduped: dropped ${dropped} identical frames, ${kept.length} remain.\n`);
        } else {
          process.stdout.write(`Deduped: no consecutive duplicates found.\n`);
        }
      }

      if (opts.gif || opts.mp4) {
        const fps = typeof opts.fps === "number" ? opts.fps : 15;
        const { spawnSync } = await import("node:child_process");
        const which = spawnSync("which", ["ffmpeg"]);
        if (which.status !== 0) {
          process.stderr.write("[chrome-relay] ffmpeg not on PATH — skipping --gif/--mp4.\n");
          return;
        }
        if (opts.gif) {
          const gifOut = `${opts.out.replace(/\/$/, "")}.gif`;
          const r = spawnSync("ffmpeg", [
            "-y", "-framerate", String(fps),
            "-i", path.join(opts.out, "frame_%04d.jpg"),
            "-vf", `fps=${fps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
            "-loop", "0",
            gifOut
          ], { stdio: "inherit" });
          if (r.status === 0) process.stdout.write(`Wrote ${gifOut}\n`);
        }
        if (opts.mp4) {
          const mp4Out = `${opts.out.replace(/\/$/, "")}.mp4`;
          const r = spawnSync("ffmpeg", [
            "-y", "-framerate", String(fps),
            "-i", path.join(opts.out, "frame_%04d.jpg"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
            mp4Out
          ], { stdio: "inherit" });
          if (r.status === 0) process.stdout.write(`Wrote ${mp4Out}\n`);
        }
      }
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.message : String(error)) + "\n"
      );
      process.exit(1);
    }
  });
}
