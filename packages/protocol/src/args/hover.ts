// chrome_hover arg schema.
//
// Hover is the canonical "mixed shape" tool: either selector OR (x,y).
// The parser collapses both into a discriminated union the handler can
// branch on without re-doing the typeof dance.
import { RelayError, TOOL_NAMES } from "./../index";
import { asObject, optString, optNumber, parseTargetArgs, type TargetArgs } from "./shared";
import { rejectMixedAddressing } from "./simple";

export type ChromeHoverArgs =
  | (TargetArgs & { kind: "ref"; ref: string })
  | (TargetArgs & { kind: "selector"; selector: string })
  | (TargetArgs & { kind: "coords"; x: number; y: number });

export function parseChromeHoverArgs(input: unknown): ChromeHoverArgs {
  const obj = asObject(input, TOOL_NAMES.HOVER);
  const target = parseTargetArgs(obj, TOOL_NAMES.HOVER);
  const x = optNumber(obj, "x", TOOL_NAMES.HOVER);
  const y = optNumber(obj, "y", TOOL_NAMES.HOVER);
  // Strict: x without y (or vice versa) is a typo/incomplete-intent.
  // The old behavior silently fell through to selector-mode, losing the
  // coordinate intent. Reject explicitly.
  if ((x !== undefined) !== (y !== undefined)) {
    throw new RelayError({
      code: "invalid_arguments",
      message: "chrome_hover: pass BOTH x and y, or neither (selector mode).",
      tool: TOOL_NAMES.HOVER,
      phase: "parse_arguments",
      details: { received: { x: obj.x, y: obj.y } },
      retryable: false
    });
  }
  const ref = optString(obj, "ref", TOOL_NAMES.HOVER);
  const selector = optString(obj, "selector", TOOL_NAMES.HOVER);
  rejectMixedAddressing(TOOL_NAMES.HOVER, obj, { ref, selector, coords: x !== undefined });
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
    message: "chrome_hover requires a @ref, a selector, or x AND y.",
    tool: TOOL_NAMES.HOVER,
    phase: "parse_arguments",
    details: { received: { ref: obj.ref, selector: obj.selector, x: obj.x, y: obj.y } },
    retryable: false
  });
}
