// chrome_upload — three upload strategies as actions, mirroring the click-
// strategy taxonomy (docs/multi-profile-and-upload.md Part 2):
//
//   set    — DOM.setFileInputFiles on a resolved <input type="file">.
//   choose — arm Page.setInterceptFileChooserDialog BEFORE clicking a
//            trigger, catch fileChooserOpened, set files on the intercepted
//            node. The arming order is what keeps the OS picker off the
//            user's screen.
//   drop   — Input.dispatchDragEvent dragEnter/dragOver/drop with path-based
//            DragData.files on a drop zone.
//
// Every strategy carries file PATHS — Chrome reads the files itself, nothing
// crosses the bridge. The CLI stats each path before sending (file_not_found
// fails locally); the extension treats the list as opaque absolute paths.

import { RelayError, type ToolName } from "./../index";
import {
  asObject,
  optNumber,
  optString,
  parseTargetArgs,
  type TargetArgs
} from "./shared";

export type ChromeUploadAction = "set" | "choose" | "drop";

export interface ChromeUploadArgs extends TargetArgs {
  action: ChromeUploadAction;
  /** Absolute file paths, already stat-verified CLI-side. */
  files: string[];
  /** set/drop: target element as a ref id (wire form, possibly qualified). */
  ref?: string;
  /** set/drop: target element as a CSS selector. */
  selector?: string;
  /** choose: the trigger to click, as a ref id. */
  clickRef?: string;
  /** choose: the trigger to click, as a CSS selector. */
  clickSelector?: string;
  /** choose: ms to wait for fileChooserOpened after the click. */
  timeoutMs?: number;
}

// Literal (not TOOL_NAMES.UPLOAD): index.ts re-exports args/ before
// TOOL_NAMES initializes, so a module-eval-time read would crash on the
// circular import. The ToolName annotation keeps it honest.
const TOOL: ToolName = "chrome_upload";

function bad(message: string, details?: Record<string, unknown>): never {
  throw new RelayError({
    code: "invalid_arguments",
    message: `${TOOL}: ${message}`,
    tool: TOOL,
    phase: "parse_arguments",
    details,
    retryable: false
  });
}

function exactlyOne(pairs: Array<[string, string | undefined]>, what: string): void {
  const present = pairs.filter(([, v]) => v !== undefined).map(([k]) => k);
  if (present.length !== 1) {
    bad(
      `${what} requires exactly one of ${pairs.map(([k]) => `\`${k}\``).join(" / ")} (got ${present.length ? present.join(" + ") : "none"}).`,
      { present }
    );
  }
}

export function parseChromeUploadArgs(input: unknown): ChromeUploadArgs {
  const obj = asObject(input, TOOL);

  const action = optString(obj, "action", TOOL);
  if (action !== "set" && action !== "choose" && action !== "drop") {
    bad(`\`action\` must be "set" | "choose" | "drop" (got ${JSON.stringify(action)}).`, {
      received: action
    });
  }

  const rawFiles = obj.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.some((f) => typeof f !== "string" || !f)) {
    bad("`files` must be a non-empty array of path strings.", { received: rawFiles });
  }
  const files = rawFiles as string[];

  const ref = optString(obj, "ref", TOOL);
  const selector = optString(obj, "selector", TOOL);
  const clickRef = optString(obj, "clickRef", TOOL);
  const clickSelector = optString(obj, "clickSelector", TOOL);
  const timeoutMs = optNumber(obj, "timeoutMs", TOOL);

  if (action === "choose") {
    exactlyOne([["clickRef", clickRef], ["clickSelector", clickSelector]], "action=choose");
    if (ref !== undefined || selector !== undefined) {
      bad("action=choose targets the TRIGGER via `clickRef`/`clickSelector`; `ref`/`selector` don't apply.", {
        present: { ref, selector }
      });
    }
  } else {
    exactlyOne([["ref", ref], ["selector", selector]], `action=${action}`);
    if (clickRef !== undefined || clickSelector !== undefined) {
      bad(`\`clickRef\`/\`clickSelector\` only apply to action=choose (got action=${action}).`, {
        present: { clickRef, clickSelector }
      });
    }
    if (timeoutMs !== undefined) {
      bad("`timeoutMs` only applies to action=choose (the wait for fileChooserOpened).", {
        received: timeoutMs
      });
    }
  }

  return {
    action,
    files,
    ...(ref !== undefined ? { ref } : {}),
    ...(selector !== undefined ? { selector } : {}),
    ...(clickRef !== undefined ? { clickRef } : {}),
    ...(clickSelector !== undefined ? { clickSelector } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...parseTargetArgs(obj, TOOL)
  };
}
