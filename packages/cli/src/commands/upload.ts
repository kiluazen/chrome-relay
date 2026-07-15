// upload — file upload, three strategies as verbs. No auto-fallback: each
// mechanism has one failure mode, the failure names the strategy, the agent
// picks what to try next (same taxonomy as the click strategies).
//
// Every strategy sends file PATHS — Chrome reads the files itself, nothing
// crosses the bridge, no size caps. Paths are stat()ed HERE so a typo fails
// locally as file_not_found before anything goes over the wire.

import { statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { parseRefToken, RelayError, TOOL_NAMES } from "@chrome-relay/protocol";
import { tabOpt, type CommandContext, type TargetOpts } from "./shared.js";

interface UploadFlagOpts extends TargetOpts {
  ref?: string;
  selector?: string;
  clickRef?: string;
  clickSelector?: string;
  timeout?: number;
}

function localFail(error: RelayError): never {
  process.stderr.write(error.message + "\n");
  process.stderr.write(JSON.stringify({ relayError: error.toBridgeError() }, null, 2) + "\n");
  process.exit(1);
}

/** stat + absolutize every file, echoing the resolution. Relative paths
 *  resolve against cwd; a missing file fails fast with the resolved path
 *  so the agent sees exactly what was looked for. */
function resolveFiles(files: string[]): string[] {
  return files.map((f) => {
    const resolved = path.resolve(f);
    let isFile = false;
    try {
      isFile = statSync(resolved).isFile();
    } catch {
      /* fall through */
    }
    if (!isFile) {
      localFail(
        new RelayError({
          code: "file_not_found",
          message: `chrome_upload: ${resolved} does not exist or is not a regular file (from \`${f}\`).`,
          tool: TOOL_NAMES.UPLOAD,
          phase: "stat_files",
          details: { received: f, resolved },
          retryable: false
        })
      );
    }
    return resolved;
  });
}

/** `--ref` / `--click-ref` accept the printed token (@3f2a:e12) or its bare
 *  form; anything else is a structural error, not a selector fallback. */
function refValue(flag: string, value: string): string {
  const parsed = parseRefToken(value) ?? parseRefToken(`@${value}`);
  if (!parsed) {
    localFail(
      new RelayError({
        code: "invalid_arguments",
        message: `chrome_upload: ${flag} expects a ref token like @3f2a:e12 (got ${JSON.stringify(value)}). For a CSS selector use ${flag === "--ref" ? "--selector" : "--click-selector"}.`,
        tool: TOOL_NAMES.UPLOAD,
        phase: "parse_arguments",
        details: { flag, received: value },
        retryable: false
      })
    );
  }
  return parsed;
}

export function registerUpload(ctx: CommandContext): void {
  const { program, withBase, run } = ctx;

  const upload = program
    .command("upload")
    .description("Upload files: set an <input type=file>, drive an intercepted picker, or drop onto a drop zone.")
    .addHelpText(
      "after",
      `

Strategies (pick one — failures name the strategy, no auto-fallback):
  set     Direct DOM.setFileInputFiles on an <input type="file">. Works on
          hidden inputs. Fails not_a_file_input if the target isn't one.
  choose  For a button that opens the OS picker: interception is armed
          BEFORE the click, so no dialog ever appears on screen. Fails
          no_file_chooser if the click opened nothing.
  drop    Dispatches dragEnter/dragOver/drop with the files onto a drop
          zone. Result reports dropHandled (did a handler preventDefault).

Examples:
  chrome-relay upload set --ref @3f2a:e12 ./cv.pdf
  chrome-relay upload set --selector 'input[type=file]' ./cv.pdf ./cover.pdf
  chrome-relay upload choose --click-ref @3f2a:e4 ./cv.pdf
  chrome-relay upload choose --click-selector '#upload-btn' --timeout 8000 ./cv.pdf
  chrome-relay upload drop --selector '.dropzone' ./avatar.png

Notes:
  Files are PATHS — Chrome reads them itself; nothing crosses the bridge and
  there is no size cap. Missing paths fail locally as file_not_found.
  Requires the extension's "Allow access to file URLs" toggle (Chrome gates
  debugger file ops on it) — \`chrome-relay doctor\` checks it; failures
  surface as file_access_denied with the fix.
  Verified results: set/choose read back input.files and report what the
  input ACTUALLY holds. accept-attribute mismatches ride along as warnings.
`
    );

  tabOpt(
    upload
      .command("set <files...>")
      .description("Set files directly on an <input type=file> (works when hidden).")
      .option("--ref <token>", "target input by snapshot ref, e.g. @3f2a:e12")
      .option("--selector <css>", "target input by CSS selector")
  ).action(async (files: string[], opts: UploadFlagOpts) => {
    const extras: Record<string, unknown> = { action: "set", files: resolveFiles(files) };
    if (opts.ref) extras.ref = refValue("--ref", opts.ref);
    if (opts.selector) extras.selector = opts.selector;
    await run(TOOL_NAMES.UPLOAD, withBase(opts, extras));
  });

  tabOpt(
    upload
      .command("choose <files...>")
      .description("Click a trigger with the file chooser intercepted (no OS dialog).")
      .option("--click-ref <token>", "the trigger to click, by snapshot ref")
      .option("--click-selector <css>", "the trigger to click, by CSS selector")
      .option("--timeout <ms>", "how long to wait for the chooser after the click (default 5000)", (v) => Number(v))
  ).action(async (files: string[], opts: UploadFlagOpts) => {
    const extras: Record<string, unknown> = { action: "choose", files: resolveFiles(files) };
    if (opts.clickRef) extras.clickRef = refValue("--click-ref", opts.clickRef);
    if (opts.clickSelector) extras.clickSelector = opts.clickSelector;
    if (typeof opts.timeout === "number") extras.timeoutMs = opts.timeout;
    await run(TOOL_NAMES.UPLOAD, withBase(opts, extras));
  });

  tabOpt(
    upload
      .command("drop <files...>")
      .description("Drop files onto a drop zone (dragEnter → dragOver → drop).")
      .option("--ref <token>", "drop target by snapshot ref")
      .option("--selector <css>", "drop target by CSS selector")
  ).action(async (files: string[], opts: UploadFlagOpts) => {
    const extras: Record<string, unknown> = { action: "drop", files: resolveFiles(files) };
    if (opts.ref) extras.ref = refValue("--ref", opts.ref);
    if (opts.selector) extras.selector = opts.selector;
    await run(TOOL_NAMES.UPLOAD, withBase(opts, extras));
  });
}
