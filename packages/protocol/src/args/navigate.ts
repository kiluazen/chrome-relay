// chrome_navigate arg schema.
import { MAX_WAIT_TIMEOUT_MS, RelayError, TOOL_NAMES } from "./../index";
import {
  asObject,
  optBool,
  optNumber,
  optString,
  parseTargetArgs,
  requireString,
  type TargetArgs
} from "./shared";

export interface ChromeNavigateArgs extends TargetArgs {
  url: string;
  newTab?: boolean;
  active?: boolean;
  allowPartial?: boolean;
  /** Return once the new document reaches this state (bounded by
   *  waitTimeoutMs; a slow page returns ready:false, never an error).
   *  Omitted = "none": return as soon as Chrome accepts the navigation —
   *  the pre-0.9 behavior, kept for callers that don't send the field. */
  waitUntil?: NavigateWaitUntil;
  waitTimeoutMs?: number;
}

export type NavigateWaitUntil = "none" | "commit" | "domcontentloaded" | "load";
const WAIT_UNTIL_VALUES: readonly NavigateWaitUntil[] = ["none", "commit", "domcontentloaded", "load"];

export function parseChromeNavigateArgs(input: unknown): ChromeNavigateArgs {
  const obj = asObject(input, TOOL_NAMES.NAVIGATE);
  const out: ChromeNavigateArgs = { url: requireString(obj, "url", TOOL_NAMES.NAVIGATE) };
  // navigate accepts string OR numeric tabId for back-compat (it's used
  // as a "reference window" rather than a strict target when --new is
  // set). Strict: a string that doesn't parse to a finite number is
  // rejected. We handle tabId ourselves (rather than parseTargetArgs,
  // which is number-strict).
  if (typeof obj.tabId === "string" && obj.tabId) {
    const n = Number(obj.tabId);
    if (!Number.isFinite(n)) {
      throw new RelayError({
        code: "invalid_arguments",
        message: `chrome_navigate: invalid tabId ${JSON.stringify(obj.tabId)}. Expected a number.`,
        tool: TOOL_NAMES.NAVIGATE,
        phase: "parse_arguments",
        details: { field: "tabId", received: obj.tabId },
        retryable: false
      });
    }
    out.tabId = n;
  } else {
    const n = optNumber(obj, "tabId", TOOL_NAMES.NAVIGATE);
    if (n !== undefined) out.tabId = n;
  }
  // Workspace + group come from parseTargetArgs (strict); we strip tabId
  // first so the numeric-or-string handling above stays the source of truth.
  const { tabId: _, ...rest } = obj;
  const target = parseTargetArgs(rest, TOOL_NAMES.NAVIGATE);
  if (target.workspaceName) out.workspaceName = target.workspaceName;
  if (target.groupName)     out.groupName     = target.groupName;
  const newTab = optBool(obj, "newTab", TOOL_NAMES.NAVIGATE);
  if (newTab !== undefined) out.newTab = newTab;
  const active = optBool(obj, "active", TOOL_NAMES.NAVIGATE);
  if (active === true) {
    throw new RelayError({
      code: "invalid_arguments",
      message: "Chrome Relay operates in the background. Remove active:true and target the tab by tabId instead.",
      tool: TOOL_NAMES.NAVIGATE,
      phase: "background_only",
      retryable: false
    });
  }
  if (active !== undefined) out.active = active;
  const allowPartial = optBool(obj, "allowPartial", TOOL_NAMES.NAVIGATE);
  if (allowPartial !== undefined) out.allowPartial = allowPartial;
  const waitUntil = optString(obj, "waitUntil", TOOL_NAMES.NAVIGATE);
  if (waitUntil !== undefined) {
    if (!(WAIT_UNTIL_VALUES as readonly string[]).includes(waitUntil)) {
      throw new RelayError({
        code: "invalid_arguments",
        message: `chrome_navigate: waitUntil must be one of ${WAIT_UNTIL_VALUES.join(" | ")} (got ${JSON.stringify(waitUntil)}).`,
        tool: TOOL_NAMES.NAVIGATE,
        phase: "parse_arguments",
        details: { field: "waitUntil", received: waitUntil },
        retryable: false
      });
    }
    out.waitUntil = waitUntil as NavigateWaitUntil;
  }
  const waitTimeoutMs = optNumber(obj, "waitTimeoutMs", TOOL_NAMES.NAVIGATE);
  if (waitTimeoutMs !== undefined) out.waitTimeoutMs = Math.max(0, Math.min(waitTimeoutMs, MAX_WAIT_TIMEOUT_MS));
  return out;
}
