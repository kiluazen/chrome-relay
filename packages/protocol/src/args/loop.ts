// Parsers for the loop-ergonomics tools (adoption-spec Changes 3, 5, 6):
// chrome_wait, chrome_batch, chrome_get.

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_BATCH_COMMANDS,
  MAX_WAIT_TIMEOUT_MS
} from "../limits";
import { RelayError, TOOL_NAMES, type ToolArguments, type ToolName } from "./../index";
import {
  asObject,
  optBool,
  optPositiveNumber,
  optString,
  parseTargetArgs,
  requireString,
  type TargetArgs
} from "./shared";

// ---------------------------------------------------------------------------
// chrome_wait — exactly ONE condition per call. No condition soup: an agent
// that needs two conditions runs two waits and knows which one timed out.

export type WaitCondition =
  | { kind: "selector"; selector: string }
  | { kind: "ref"; ref: string }
  | { kind: "text"; text: string }
  | { kind: "url"; urlGlob: string }
  | { kind: "load"; state: "load" | "domcontentloaded" | "networkidle" }
  | { kind: "fn"; fn: string };

export type ChromeWaitArgs = TargetArgs & {
  condition: WaitCondition;
  timeoutMs: number;
};

const LOAD_STATES = new Set(["load", "domcontentloaded", "networkidle"]);

export function parseChromeWaitArgs(input: unknown): ChromeWaitArgs {
  const obj = asObject(input, TOOL_NAMES.WAIT);
  const target = parseTargetArgs(obj, TOOL_NAMES.WAIT);

  const candidates: WaitCondition[] = [];
  const selector = optString(obj, "selector", TOOL_NAMES.WAIT);
  if (selector) candidates.push({ kind: "selector", selector });
  const ref = optString(obj, "ref", TOOL_NAMES.WAIT);
  if (ref) candidates.push({ kind: "ref", ref });
  const text = optString(obj, "text", TOOL_NAMES.WAIT);
  if (text) candidates.push({ kind: "text", text });
  const urlGlob = optString(obj, "urlGlob", TOOL_NAMES.WAIT);
  if (urlGlob) candidates.push({ kind: "url", urlGlob });
  const load = optString(obj, "load", TOOL_NAMES.WAIT);
  if (load) {
    if (!LOAD_STATES.has(load)) {
      throw new RelayError({
        code: "invalid_arguments",
        message: `${TOOL_NAMES.WAIT}: \`load\` must be one of load | domcontentloaded | networkidle (got ${load}).`,
        tool: TOOL_NAMES.WAIT,
        phase: "parse_arguments",
        details: { received: load },
        retryable: false
      });
    }
    candidates.push({ kind: "load", state: load as "load" | "domcontentloaded" | "networkidle" });
  }
  const fn = optString(obj, "fn", TOOL_NAMES.WAIT);
  if (fn) candidates.push({ kind: "fn", fn });

  if (candidates.length !== 1) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.WAIT}: pass exactly one condition (selector | ref | text | urlGlob | load | fn); got ${candidates.length}.`,
      tool: TOOL_NAMES.WAIT,
      phase: "parse_arguments",
      details: { received: candidates.map((c) => c.kind) },
      retryable: false
    });
  }

  const timeoutRaw = optPositiveNumber(obj, "timeoutMs", TOOL_NAMES.WAIT) ?? DEFAULT_WAIT_TIMEOUT_MS;
  return {
    ...target,
    condition: candidates[0],
    timeoutMs: Math.min(timeoutRaw, MAX_WAIT_TIMEOUT_MS)
  };
}

// ---------------------------------------------------------------------------
// chrome_batch

export interface BatchCommand {
  name: ToolName;
  args?: ToolArguments;
}
export interface ChromeBatchArgs {
  commands: BatchCommand[];
  bail: boolean; // default true — stop at first error
}

export function parseChromeBatchArgs(input: unknown): ChromeBatchArgs {
  const obj = asObject(input, TOOL_NAMES.BATCH);
  if (!Array.isArray(obj.commands) || obj.commands.length === 0) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.BATCH}: \`commands\` must be a non-empty array of { name, args? }.`,
      tool: TOOL_NAMES.BATCH,
      phase: "parse_arguments",
      details: { received: obj.commands },
      retryable: false
    });
  }
  if (obj.commands.length > MAX_BATCH_COMMANDS) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.BATCH}: at most ${MAX_BATCH_COMMANDS} commands per batch (got ${obj.commands.length}).`,
      tool: TOOL_NAMES.BATCH,
      phase: "parse_arguments",
      details: { received: obj.commands.length },
      retryable: false
    });
  }
  const commands: BatchCommand[] = obj.commands.map((c, i) => {
    const cmd = asObject(c, TOOL_NAMES.BATCH);
    const name = requireString(cmd, "name", TOOL_NAMES.BATCH);
    if (name === TOOL_NAMES.BATCH) {
      throw new RelayError({
        code: "invalid_arguments",
        message: `${TOOL_NAMES.BATCH}: command ${i} nests a batch inside a batch — not supported.`,
        tool: TOOL_NAMES.BATCH,
        phase: "parse_arguments",
        details: { index: i },
        retryable: false
      });
    }
    return { name: name as ToolName, args: (cmd.args as ToolArguments) ?? {} };
  });
  return { commands, bail: optBool(obj, "bail", TOOL_NAMES.BATCH) ?? true };
}

// ---------------------------------------------------------------------------
// chrome_get

// title/url are separate members (not `what: "title" | "url"`) so TS can
// narrow the union by exclusion after early returns in the handler.
export type ChromeGetArgs = TargetArgs & (
  | { what: "title" }
  | { what: "url" }
  | { what: "count"; selector: string }
  | { what: "text" | "value"; selector?: string; ref?: string }
  | { what: "attr"; attrName: string; selector?: string; ref?: string }
);

const GET_WHATS = new Set(["text", "value", "attr", "count", "title", "url"]);

export function parseChromeGetArgs(input: unknown): ChromeGetArgs {
  const obj = asObject(input, TOOL_NAMES.GET);
  const target = parseTargetArgs(obj, TOOL_NAMES.GET);
  const what = requireString(obj, "what", TOOL_NAMES.GET);
  if (!GET_WHATS.has(what)) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.GET}: \`what\` must be one of text | value | attr | count | title | url (got ${what}).`,
      tool: TOOL_NAMES.GET,
      phase: "parse_arguments",
      details: { received: what },
      retryable: false
    });
  }
  if (what === "title" || what === "url") {
    return { ...target, what: what as "title" };
  }
  if (what === "count") {
    return { ...target, what, selector: requireString(obj, "selector", TOOL_NAMES.GET) };
  }
  const selector = optString(obj, "selector", TOOL_NAMES.GET);
  const ref = optString(obj, "ref", TOOL_NAMES.GET);
  if ((selector ? 1 : 0) + (ref ? 1 : 0) !== 1) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${TOOL_NAMES.GET} ${what}: pass exactly one of \`selector\` or \`ref\`.`,
      tool: TOOL_NAMES.GET,
      phase: "parse_arguments",
      details: { received: { selector, ref } },
      retryable: false
    });
  }
  if (what === "attr") {
    return { ...target, what, attrName: requireString(obj, "attrName", TOOL_NAMES.GET), selector, ref };
  }
  return { ...target, what: what as "text" | "value", selector, ref };
}
