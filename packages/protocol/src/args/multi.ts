// Parsers for the multi-action tools — `action` field selects the shape.
// Co-located here so the discriminated-union shapes are easy to compare.

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

function invalidAction(tool: string, received: unknown, expected: readonly string[]): never {
  throw new RelayError({
    code: "invalid_arguments",
    message: `${tool}: unknown action ${JSON.stringify(received)}. Expected ${expected.join(" | ")}.`,
    tool: tool as never,
    phase: "parse_action",
    details: { received, validChoices: expected },
    retryable: false
  });
}

// ---------------------------------------------------------------------------
// chrome_viewport

const VALID_VIEWPORT_ACTIONS = ["set", "preset", "clear", "list"] as const;
export type ChromeViewportArgs =
  | { action: "list" }
  | (TargetArgs & { action: "clear" })
  | (TargetArgs & { action: "preset"; name: string })
  | (TargetArgs & {
      action: "set";
      width: number;
      height: number;
      dpr?: number;
      mobile?: boolean;
      hasTouch?: boolean;
      userAgent?: string;
    });

export function parseChromeViewportArgs(input: unknown): ChromeViewportArgs {
  const obj = asObject(input, TOOL_NAMES.VIEWPORT);
  const action = typeof obj.action === "string" ? obj.action : "set";
  if (!(VALID_VIEWPORT_ACTIONS as readonly string[]).includes(action)) {
    invalidAction(TOOL_NAMES.VIEWPORT, action, VALID_VIEWPORT_ACTIONS);
  }
  const target = parseTargetArgs(obj);
  if (action === "list") return { action: "list" };
  if (action === "clear") return { ...target, action: "clear" };
  if (action === "preset") {
    return { ...target, action: "preset", name: requireString(obj, "name", TOOL_NAMES.VIEWPORT) };
  }
  // action === "set"
  const width  = Number(obj.width);
  const height = Number(obj.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.VIEWPORT} set requires positive numeric width and height.`,
      tool: TOOL_NAMES.VIEWPORT,
      phase: "parse_dimensions",
      details: { received: { width: obj.width, height: obj.height } },
      retryable: false
    });
  }
  const out: TargetArgs & { action: "set"; width: number; height: number; dpr?: number; mobile?: boolean; hasTouch?: boolean; userAgent?: string } = {
    ...target, action: "set", width, height
  };
  const dpr = optNumber(obj, "dpr"); if (dpr !== undefined) out.dpr = dpr;
  const mobile = optBool(obj, "mobile"); if (mobile !== undefined) out.mobile = mobile;
  const hasTouch = optBool(obj, "hasTouch"); if (hasTouch !== undefined) out.hasTouch = hasTouch;
  const userAgent = optString(obj, "userAgent"); if (userAgent) out.userAgent = userAgent;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_console

const VALID_CONSOLE_ACTIONS = ["read", "clear"] as const;
const VALID_CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug", "exception"] as const;
export type ConsoleLevel = typeof VALID_CONSOLE_LEVELS[number];

export type ChromeConsoleArgs =
  | (TargetArgs & { action: "clear" })
  | (TargetArgs & { action: "read"; levels?: ConsoleLevel[]; since?: number; limit?: number });

function parseLevels(input: unknown): ConsoleLevel[] | undefined {
  if (input === undefined || input === null) return undefined;
  const valid = new Set<string>(VALID_CONSOLE_LEVELS as readonly string[]);
  const verify = (s: unknown): ConsoleLevel => {
    if (typeof s !== "string" || !valid.has(s)) {
      throw new RelayError({
        code: "invalid_arguments",
        message: `${TOOL_NAMES.CONSOLE}: invalid level ${JSON.stringify(s)}. Expected one of: ${(VALID_CONSOLE_LEVELS as readonly string[]).join(", ")}.`,
        tool: TOOL_NAMES.CONSOLE,
        phase: "parse_levels",
        details: { received: s, validChoices: VALID_CONSOLE_LEVELS },
        retryable: false
      });
    }
    return s as ConsoleLevel;
  };
  if (typeof input === "string") return input.split(",").map((s) => verify(s.trim()));
  if (Array.isArray(input)) return input.map(verify);
  throw new RelayError({
    code: "invalid_arguments",
    message: `${TOOL_NAMES.CONSOLE}: invalid levels argument ${JSON.stringify(input)}. Expected a comma-separated string or an array of strings.`,
    tool: TOOL_NAMES.CONSOLE,
    phase: "parse_levels",
    details: { received: input },
    retryable: false
  });
}

export function parseChromeConsoleArgs(input: unknown): ChromeConsoleArgs {
  const obj = asObject(input, TOOL_NAMES.CONSOLE);
  const target = parseTargetArgs(obj);
  const action = typeof obj.action === "string" ? obj.action : "read";
  if (!(VALID_CONSOLE_ACTIONS as readonly string[]).includes(action)) {
    invalidAction(TOOL_NAMES.CONSOLE, action, VALID_CONSOLE_ACTIONS);
  }
  if (action === "clear") return { ...target, action: "clear" };
  const out: TargetArgs & { action: "read"; levels?: ConsoleLevel[]; since?: number; limit?: number } = { ...target, action: "read" };
  const levels = parseLevels(obj.levels); if (levels) out.levels = levels;
  const since = optNumber(obj, "since"); if (since !== undefined) out.since = since;
  const limit = optNumber(obj, "limit"); if (limit !== undefined) out.limit = limit;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_workspace

const VALID_WORKSPACE_ACTIONS = ["create", "list", "close"] as const;
export type ChromeWorkspaceArgs =
  | { action: "list" }
  | { action: "create"; name: string; url?: string; label?: string }
  | { action: "close"; name: string };

export function parseChromeWorkspaceArgs(input: unknown): ChromeWorkspaceArgs {
  const obj = asObject(input, TOOL_NAMES.WORKSPACE);
  const action = typeof obj.action === "string" ? obj.action : "list";
  if (!(VALID_WORKSPACE_ACTIONS as readonly string[]).includes(action)) {
    invalidAction(TOOL_NAMES.WORKSPACE, action, VALID_WORKSPACE_ACTIONS);
  }
  if (action === "list") return { action: "list" };
  if (action === "close") return { action: "close", name: requireString(obj, "name", TOOL_NAMES.WORKSPACE) };
  // create
  const out: { action: "create"; name: string; url?: string; label?: string } = {
    action: "create",
    name: requireString(obj, "name", TOOL_NAMES.WORKSPACE)
  };
  const url = optString(obj, "url"); if (url) out.url = url;
  const label = optString(obj, "label"); if (label) out.label = label;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_group

const VALID_GROUP_ACTIONS = ["create", "list", "close", "add", "remove"] as const;
const VALID_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
export type TabGroupColor = typeof VALID_GROUP_COLORS[number];

export type ChromeGroupArgs =
  | { action: "list" }
  | { action: "create"; name: string; tabIds: number[]; color?: TabGroupColor; collapsed?: boolean; windowId?: number }
  | { action: "close"; name: string }
  | { action: "add"; name: string; tabIds: number[] }
  | { action: "remove"; tabIds: number[] };

function parseTabIds(raw: unknown): number[] {
  const reject = (bad: unknown): never => {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.GROUP}: invalid tabId ${JSON.stringify(bad)}. Expected a number or a comma-separated list of numbers.`,
      tool: TOOL_NAMES.GROUP,
      phase: "parse_tab_ids",
      details: { received: bad },
      retryable: false
    });
  };
  const coerce = (v: unknown): number => {
    const n = Number(typeof v === "string" ? v.trim() : v);
    if (!Number.isFinite(n)) reject(v);
    return n;
  };
  if (Array.isArray(raw)) return raw.map(coerce);
  if (typeof raw === "string") return raw.split(",").map(coerce);
  if (typeof raw === "number") return [raw];
  return [];
}

function parseColor(raw: unknown): TabGroupColor | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.GROUP}: invalid color ${JSON.stringify(raw)}. Expected one of: ${VALID_GROUP_COLORS.join(", ")}.`,
      tool: TOOL_NAMES.GROUP,
      phase: "parse_color",
      details: { received: raw, validChoices: VALID_GROUP_COLORS },
      retryable: false
    });
  }
  const c = raw.toLowerCase();
  if (!(VALID_GROUP_COLORS as readonly string[]).includes(c)) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.GROUP}: invalid color "${raw}". Expected one of: ${VALID_GROUP_COLORS.join(", ")}.`,
      tool: TOOL_NAMES.GROUP,
      phase: "parse_color",
      details: { received: raw, validChoices: VALID_GROUP_COLORS },
      retryable: false
    });
  }
  return c as TabGroupColor;
}

export function parseChromeGroupArgs(input: unknown): ChromeGroupArgs {
  const obj = asObject(input, TOOL_NAMES.GROUP);
  const action = typeof obj.action === "string" ? obj.action : "list";
  if (!(VALID_GROUP_ACTIONS as readonly string[]).includes(action)) {
    invalidAction(TOOL_NAMES.GROUP, action, VALID_GROUP_ACTIONS);
  }
  if (action === "list") return { action: "list" };
  if (action === "close") return { action: "close", name: requireString(obj, "name", TOOL_NAMES.GROUP) };
  if (action === "remove") {
    const tabIds = parseTabIds(obj.tabIds);
    if (tabIds.length === 0) {
      throw new RelayError({
        code: "invalid_arguments",
        message: `${TOOL_NAMES.GROUP} remove requires tabIds.`,
        tool: TOOL_NAMES.GROUP,
        phase: "parse_arguments",
        details: { field: "tabIds" },
        retryable: false
      });
    }
    return { action: "remove", tabIds };
  }
  if (action === "add") {
    const tabIds = parseTabIds(obj.tabIds);
    if (tabIds.length === 0) {
      throw new RelayError({
        code: "invalid_arguments",
        message: `${TOOL_NAMES.GROUP} add requires tabIds.`,
        tool: TOOL_NAMES.GROUP,
        phase: "parse_arguments",
        details: { field: "tabIds" },
        retryable: false
      });
    }
    return { action: "add", name: requireString(obj, "name", TOOL_NAMES.GROUP), tabIds };
  }
  // create
  const tabIds = parseTabIds(obj.tabIds);
  if (tabIds.length === 0) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.GROUP} create requires at least one tabId.`,
      tool: TOOL_NAMES.GROUP,
      phase: "parse_arguments",
      details: { field: "tabIds" },
      retryable: false
    });
  }
  const out: { action: "create"; name: string; tabIds: number[]; color?: TabGroupColor; collapsed?: boolean; windowId?: number } = {
    action: "create",
    name: requireString(obj, "name", TOOL_NAMES.GROUP),
    tabIds
  };
  const color = parseColor(obj.color); if (color) out.color = color;
  const collapsed = optBool(obj, "collapsed"); if (collapsed !== undefined) out.collapsed = collapsed;
  const windowId = optNumber(obj, "windowId"); if (windowId !== undefined) out.windowId = windowId;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_screencast

const VALID_SCREENCAST_ACTIONS = ["start", "stop"] as const;
const VALID_SCREENCAST_FORMATS = ["jpeg", "png"] as const;
export type ScreencastFormat = typeof VALID_SCREENCAST_FORMATS[number];

export type ChromeScreencastArgs =
  | (TargetArgs & { action: "stop" })
  | (TargetArgs & {
      action: "start";
      format?: ScreencastFormat;
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
      everyNthFrame?: number;
    });

export function parseChromeScreencastArgs(input: unknown): ChromeScreencastArgs {
  const obj = asObject(input, TOOL_NAMES.SCREENCAST);
  const target = parseTargetArgs(obj);
  const action = typeof obj.action === "string" ? obj.action : "start";
  if (!(VALID_SCREENCAST_ACTIONS as readonly string[]).includes(action)) {
    invalidAction(TOOL_NAMES.SCREENCAST, action, VALID_SCREENCAST_ACTIONS);
  }
  if (action === "stop") return { ...target, action: "stop" };
  // start
  const out: TargetArgs & { action: "start"; format?: ScreencastFormat; quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number } = {
    ...target, action: "start"
  };
  if (obj.format !== undefined && obj.format !== null) {
    if (obj.format !== "jpeg" && obj.format !== "png") {
      throw new RelayError({
        code: "invalid_arguments",
        message: `${TOOL_NAMES.SCREENCAST}: invalid format ${JSON.stringify(obj.format)}. Expected "jpeg" or "png".`,
        tool: TOOL_NAMES.SCREENCAST,
        phase: "parse_format",
        details: { received: obj.format, validChoices: VALID_SCREENCAST_FORMATS },
        retryable: false
      });
    }
    out.format = obj.format;
  }
  const q  = optNumber(obj, "quality");       if (q !== undefined)  out.quality = q;
  const mw = optNumber(obj, "maxWidth");      if (mw !== undefined) out.maxWidth = mw;
  const mh = optNumber(obj, "maxHeight");     if (mh !== undefined) out.maxHeight = mh;
  const en = optNumber(obj, "everyNthFrame"); if (en !== undefined) out.everyNthFrame = en;
  return out;
}
