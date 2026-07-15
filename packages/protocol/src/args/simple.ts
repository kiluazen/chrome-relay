// Parsers for the "simple" tools — those that take just a few required
// args plus optional target fields. Co-located here so each isn't its own
// tiny file. (The multi-action tools — viewport, network, console,
// workspace, group, screencast — stay in their own files because they're
// substantially bigger.)

import { RelayError, TOOL_NAMES, type ToolName } from "./../index";
import {
  asObject,
  coerceTabId,
  optBool,
  optNumber,
  optNonNegativeNumber,
  optPositiveNumber,
  optString,
  parseTargetArgs,
  requireString,
  type TargetArgs
} from "./shared";

// ---------------------------------------------------------------------------
// get_windows_and_tabs / chrome_self_reload — no args at all.
//
// Permissive on purpose: callers may forward extra fields they don't know
// about (e.g. a future agent shim that always passes `tabId`). We just
// drop them. The parser exists so handlers can `parseFooArgs(args)` at
// the top consistently with every other tool — no special "no-args" path.

export interface NoArgs {}
export function parseGetWindowsAndTabsArgs(input: unknown): NoArgs {
  // Validate it's at least an object (rejects strings/arrays/null). Extra
  // keys are silently ignored — see comment above.
  if (input !== undefined && input !== null) asObject(input, TOOL_NAMES.GET_WINDOWS_AND_TABS);
  return {};
}
export function parseChromeSelfReloadArgs(input: unknown): NoArgs {
  if (input !== undefined && input !== null) asObject(input, TOOL_NAMES.SELF_RELOAD);
  return {};
}

// ---------------------------------------------------------------------------
// chrome_read_page

export interface ChromeReadPageArgs extends TargetArgs {
  interactiveOnly?: boolean;
}
export function parseChromeReadPageArgs(input: unknown): ChromeReadPageArgs {
  const obj = asObject(input, TOOL_NAMES.READ_PAGE);
  const out: ChromeReadPageArgs = { ...parseTargetArgs(obj) };
  const io = optBool(obj, "interactiveOnly");
  if (io !== undefined) out.interactiveOnly = io;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_click_element
//
// Three shapes — ref OR selector OR coords. Discriminated so the handler
// can branch without re-doing the typeof dance. Ref mode (adoption-spec
// Change 2) targets a @eN handle from a previous chrome_snapshot; the wire
// carries the bare id ("e3"). Coord path is the last-resort verb for
// canvas/SVG chart internals — the agent supplies (x, y) from a prior
// `getBoundingClientRect()` read via `js`, or from a known screenshot pixel.

export type ChromeClickArgs =
  | (TargetArgs & { kind: "ref"; ref: string })
  | (TargetArgs & { kind: "selector"; selector: string })
  | (TargetArgs & { kind: "coords"; x: number; y: number });

// Shared by click/fill/type/hover: reject more than one addressing mode in
// the same call — silent precedence would hide agent mistakes.
export function rejectMixedAddressing(
  tool: ToolName,
  obj: Record<string, unknown>,
  modes: { ref?: string; selector?: string; coords?: boolean }
): void {
  const present: string[] = [];
  if (modes.ref) present.push("ref");
  if (modes.selector) present.push("selector");
  if (modes.coords) present.push("x/y");
  if (present.length > 1) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${tool}: ${present.join(" + ")} are mutually exclusive — pass exactly one addressing mode.`,
      tool,
      phase: "parse_arguments",
      details: { received: present },
      retryable: false
    });
  }
}

export function parseChromeClickArgs(input: unknown): ChromeClickArgs {
  const obj = asObject(input, TOOL_NAMES.CLICK);
  const target = parseTargetArgs(obj, TOOL_NAMES.CLICK);
  const x = optNumber(obj, "x", TOOL_NAMES.CLICK);
  const y = optNumber(obj, "y", TOOL_NAMES.CLICK);
  // Strict: x without y (or vice versa) — same partial-coords rejection
  // as hover. Catches `--x 10` typos that would otherwise fall through.
  if ((x !== undefined) !== (y !== undefined)) {
    throw new RelayError({
      code: "invalid_arguments",
      message: "chrome_click_element: pass BOTH x and y, or neither (selector mode).",
      tool: TOOL_NAMES.CLICK,
      phase: "parse_arguments",
      details: { received: { x: obj.x, y: obj.y } },
      retryable: false
    });
  }
  const ref = optString(obj, "ref", TOOL_NAMES.CLICK);
  const selector = optString(obj, "selector", TOOL_NAMES.CLICK);
  rejectMixedAddressing(TOOL_NAMES.CLICK, obj, { ref, selector, coords: x !== undefined });
  if (ref) {
    return { ...target, kind: "ref", ref };
  }
  if (x !== undefined && y !== undefined) {
    return { ...target, kind: "coords", x, y };
  }
  if (selector) {
    return { ...target, kind: "selector", selector };
  }
  throw new RelayError({
    code: "invalid_arguments",
    message: "chrome_click_element requires a @ref, a selector, or x AND y.",
    tool: TOOL_NAMES.CLICK,
    phase: "parse_arguments",
    details: { received: { ref: obj.ref, selector: obj.selector, x: obj.x, y: obj.y } },
    retryable: false
  });
}

// ---------------------------------------------------------------------------
// chrome_fill_or_select
//
// Two addressing shapes — ref OR selector (no coords: filling needs the
// semantic element). Discriminated like click.

export type ChromeFillArgs =
  | (TargetArgs & { kind: "ref"; ref: string; value: string })
  | (TargetArgs & { kind: "selector"; selector: string; value: string });

export function parseChromeFillArgs(input: unknown): ChromeFillArgs {
  const obj = asObject(input, TOOL_NAMES.FILL);
  // `value` is permitted to be the empty string (clearing a field). But it
  // must be a string, not undefined.
  if (typeof obj.value !== "string") {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.FILL}: \`value\` is required and must be a string (empty string allowed).`,
      tool: TOOL_NAMES.FILL,
      phase: "parse_arguments",
      details: { field: "value", received: obj.value },
      retryable: false
    });
  }
  const target = parseTargetArgs(obj);
  const ref = optString(obj, "ref", TOOL_NAMES.FILL);
  const selector = optString(obj, "selector", TOOL_NAMES.FILL);
  rejectMixedAddressing(TOOL_NAMES.FILL, obj, { ref, selector });
  if (ref) {
    return { ...target, kind: "ref", ref, value: obj.value };
  }
  return {
    ...target,
    kind: "selector",
    selector: requireString(obj, "selector", TOOL_NAMES.FILL),
    value: obj.value
  };
}

// ---------------------------------------------------------------------------
// chrome_keyboard

export interface ChromeKeyboardArgs extends TargetArgs {
  keys: string;
}
export function parseChromeKeyboardArgs(input: unknown): ChromeKeyboardArgs {
  const obj = asObject(input, TOOL_NAMES.KEYBOARD);
  return {
    keys: requireString(obj, "keys", TOOL_NAMES.KEYBOARD),
    ...parseTargetArgs(obj)
  };
}

// ---------------------------------------------------------------------------
// chrome_type

export interface ChromeTypeArgs extends TargetArgs {
  text: string;
  selector?: string;
  ref?: string; // focus this @ref before inserting (adoption-spec Change 2)
}
export function parseChromeTypeArgs(input: unknown): ChromeTypeArgs {
  const obj = asObject(input, TOOL_NAMES.TYPE);
  const out: ChromeTypeArgs = {
    text: requireString(obj, "text", TOOL_NAMES.TYPE),
    ...parseTargetArgs(obj)
  };
  const selector = optString(obj, "selector");
  const ref = optString(obj, "ref", TOOL_NAMES.TYPE);
  rejectMixedAddressing(TOOL_NAMES.TYPE, obj, { ref, selector });
  if (selector) out.selector = selector;
  if (ref) out.ref = ref;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_evaluate

export interface ChromeEvaluateArgs extends TargetArgs {
  code: string;
  timeoutMs?: number;
}
export function parseChromeEvaluateArgs(input: unknown): ChromeEvaluateArgs {
  const obj = asObject(input, TOOL_NAMES.EVALUATE);
  const out: ChromeEvaluateArgs = {
    code: requireString(obj, "code", TOOL_NAMES.EVALUATE),
    ...parseTargetArgs(obj, TOOL_NAMES.EVALUATE)
  };
  const t = optPositiveNumber(obj, "timeoutMs", TOOL_NAMES.EVALUATE);
  if (t !== undefined) out.timeoutMs = t;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_switch_tab

export interface ChromeSwitchTabArgs {
  tabId: number;
}
export function parseChromeSwitchTabArgs(input: unknown): ChromeSwitchTabArgs {
  const obj = asObject(input, TOOL_NAMES.SWITCH_TAB);
  if (obj.tabId === undefined || obj.tabId === null) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.SWITCH_TAB} requires a numeric tabId.`,
      tool: TOOL_NAMES.SWITCH_TAB,
      phase: "parse_arguments",
      retryable: false
    });
  }
  return { tabId: coerceTabId(obj.tabId, TOOL_NAMES.SWITCH_TAB) };
}

// ---------------------------------------------------------------------------
// chrome_close_tabs

export interface ChromeCloseTabsArgs {
  tabIds: number[];
}
export function parseChromeCloseTabsArgs(input: unknown): ChromeCloseTabsArgs {
  const obj = asObject(input, TOOL_NAMES.CLOSE_TABS);
  if (!Array.isArray(obj.tabIds)) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.CLOSE_TABS} requires a numeric tabIds array.`,
      tool: TOOL_NAMES.CLOSE_TABS,
      phase: "parse_arguments",
      details: { field: "tabIds", received: obj.tabIds },
      retryable: false
    });
  }
  if (obj.tabIds.length === 0) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.CLOSE_TABS} requires a non-empty array of tab IDs.`,
      tool: TOOL_NAMES.CLOSE_TABS,
      phase: "parse_arguments",
      details: { received: obj.tabIds },
      retryable: false
    });
  }
  // coerceTabId rejects blank/whitespace strings (Number("") === 0 would
  // otherwise silently coerce to tab 0).
  return { tabIds: obj.tabIds.map((v) => coerceTabId(v, TOOL_NAMES.CLOSE_TABS)) };
}

// ---------------------------------------------------------------------------
// chrome_ax

export interface ChromeAxArgs extends TargetArgs {
  interactiveOnly?: boolean;
  rootRole?: string;
  includeSubframes?: boolean;
}
export function parseChromeAxArgs(input: unknown): ChromeAxArgs {
  const obj = asObject(input, TOOL_NAMES.AX);
  const out: ChromeAxArgs = { ...parseTargetArgs(obj) };
  const io = optBool(obj, "interactiveOnly"); if (io !== undefined) out.interactiveOnly = io;
  const root = optString(obj, "rootRole");     if (root)            out.rootRole = root;
  const is = optBool(obj, "includeSubframes"); if (is !== undefined) out.includeSubframes = is;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_click_ax

export interface ChromeClickAxArgs extends TargetArgs {
  node: number;
}
export function parseChromeClickAxArgs(input: unknown): ChromeClickAxArgs {
  const obj = asObject(input, TOOL_NAMES.CLICK_AX);
  const node = Number(obj.node ?? obj.id);
  if (!Number.isFinite(node) || node <= 0) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.CLICK_AX} requires \`node\` (a positive backendDOMNodeId from chrome_ax).`,
      tool: TOOL_NAMES.CLICK_AX,
      phase: "parse_arguments",
      details: { received: obj.node ?? obj.id },
      retryable: false
    });
  }
  return { node, ...parseTargetArgs(obj) };
}

// ---------------------------------------------------------------------------
// chrome_snapshot (adoption-spec Change 1)
//
// Unified page snapshot — AX tree + cursor-interactive sweep, one ref space.
// `depth` truncates the tree; `scope` restricts to a CSS-selector subtree;
// `urls` includes link hrefs in the attrs.

export interface ChromeSnapshotArgs extends TargetArgs {
  interactiveOnly?: boolean;
  depth?: number;
  scope?: string;
  urls?: boolean;
  /** Change 4 — include the previous snapshot's rendered text so the CLI
   *  can print only what changed. A full snapshot is still taken and the
   *  ref map still refreshes; diff only changes what is PRINTED. */
  diff?: boolean;
  /** Default true: long runs (>20) of identical-shape siblings keep the
   *  first 10 + one loud marker line. false = print everything. */
  elide?: boolean;
}
export function parseChromeSnapshotArgs(input: unknown): ChromeSnapshotArgs {
  const obj = asObject(input, TOOL_NAMES.SNAPSHOT);
  const out: ChromeSnapshotArgs = { ...parseTargetArgs(obj, TOOL_NAMES.SNAPSHOT) };
  const io = optBool(obj, "interactiveOnly", TOOL_NAMES.SNAPSHOT);
  if (io !== undefined) out.interactiveOnly = io;
  const depth = optPositiveNumber(obj, "depth", TOOL_NAMES.SNAPSHOT);
  if (depth !== undefined) out.depth = depth;
  const scope = optString(obj, "scope", TOOL_NAMES.SNAPSHOT);
  if (scope) out.scope = scope;
  const urls = optBool(obj, "urls", TOOL_NAMES.SNAPSHOT);
  if (urls !== undefined) out.urls = urls;
  const diff = optBool(obj, "diff", TOOL_NAMES.SNAPSHOT);
  if (diff !== undefined) out.diff = diff;
  const elide = optBool(obj, "elide", TOOL_NAMES.SNAPSHOT);
  if (elide !== undefined) out.elide = elide;
  return out;
}

// ---------------------------------------------------------------------------
// chrome_screenshot

export interface ChromeScreenshotArgs extends TargetArgs {
  fullPage?: boolean;
  bbox?: string;
  selector?: string;
  padding?: number;
  maxEdge?: number;
}
export function parseChromeScreenshotArgs(input: unknown): ChromeScreenshotArgs {
  const obj = asObject(input, TOOL_NAMES.SCREENSHOT);
  const out: ChromeScreenshotArgs = { ...parseTargetArgs(obj, TOOL_NAMES.SCREENSHOT) };
  const fp = optBool(obj, "fullPage", TOOL_NAMES.SCREENSHOT); if (fp !== undefined) out.fullPage = fp;
  const bbox = optString(obj, "bbox", TOOL_NAMES.SCREENSHOT); if (bbox) out.bbox = bbox;
  const sel  = optString(obj, "selector", TOOL_NAMES.SCREENSHOT); if (sel) out.selector = sel;
  // padding can legitimately be 0 (no pad); maxEdge must be > 0 (a 0-edge
  // image is meaningless, and the old "if > 0" silent-drop was the kind of
  // permissive behavior strict parsers exist to prevent).
  const pad  = optNonNegativeNumber(obj, "padding", TOOL_NAMES.SCREENSHOT); if (pad !== undefined) out.padding = pad;
  const me   = optPositiveNumber(obj, "maxEdge", TOOL_NAMES.SCREENSHOT); if (me !== undefined) out.maxEdge = me;
  return out;
}
