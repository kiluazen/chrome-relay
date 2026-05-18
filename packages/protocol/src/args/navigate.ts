// chrome_navigate arg schema.
import { TOOL_NAMES } from "./../index";
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
  const out: ChromeNavigateArgs = {
    url: requireString(obj, "url", TOOL_NAMES.NAVIGATE),
    ...parseTargetArgs(obj)
  };
  // navigate accepts string OR numeric tabId for back-compat (it's used as
  // a "reference window" rather than a strict target when --new is set).
  if (typeof obj.tabId === "string" && obj.tabId) {
    const n = Number(obj.tabId);
    if (Number.isFinite(n)) out.tabId = n;
  } else {
    const n = optNumber(obj, "tabId");
    if (n !== undefined) out.tabId = n;
  }
  const newTab = optBool(obj, "newTab");
  if (newTab !== undefined) out.newTab = newTab;
  const active = optBool(obj, "active");
  if (active !== undefined) out.active = active;
  const allowPartial = optBool(obj, "allowPartial");
  if (allowPartial !== undefined) out.allowPartial = allowPartial;
  // optString suppresses warnings about unused import in some configs.
  void optString;
  return out;
}
