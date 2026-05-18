// chrome_navigate arg schema.
import { RelayError, TOOL_NAMES } from "./../index";
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
}

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
  if (active !== undefined) out.active = active;
  const allowPartial = optBool(obj, "allowPartial", TOOL_NAMES.NAVIGATE);
  if (allowPartial !== undefined) out.allowPartial = allowPartial;
  void optString; // imported for parity with other parsers; unused here
  return out;
}
