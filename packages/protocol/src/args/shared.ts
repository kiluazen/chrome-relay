// Shared building blocks for tool-arg parsers.
//
// Each parser is a `(input: unknown) => TArgs` function that throws a
// RelayError(invalid_arguments) on a structural mismatch. The CLI uses
// these to validate outgoing args; the extension uses the same parser at
// the trust boundary so the contract is single-sourced from
// @chrome-relay/protocol.
//
// Pattern: lots of `typeof args.foo === "string" ? args.foo : undefined`
// boilerplate moves out of every handler into one well-tested place.
//
// Keep the helpers small and explicit. Validation is type-narrowing, not
// schema-DSL — we want to read the code and see exactly what's required
// vs optional.

import { RelayError, type ToolName } from "./../index";

export function asObject(input: unknown, tool: ToolName): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${tool}: arguments must be a JSON object.`,
      tool,
      phase: "parse_arguments",
      details: { received: input },
      retryable: false
    });
  }
  return input as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string, tool: ToolName): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `${tool}: \`${key}\` is required and must be a non-empty string.`,
      tool,
      phase: "parse_arguments",
      details: { field: key, received: v },
      retryable: false
    });
  }
  return v;
}

// Helper for "present-but-wrong-type" rejection. The parser strictness
// principle: undefined/null = "caller omitted the field" (use defaults).
// Anything else MUST match the expected type — silent coercion or drop
// would let agent typos sneak past as missing-field defaults.
function rejectWrongType(
  obj: Record<string, unknown>,
  key: string,
  expected: string,
  tool: ToolName | undefined
): never {
  throw new RelayError({
    code: "invalid_arguments",
    message: `${tool ?? "<unknown tool>"}: \`${key}\` must be ${expected} (got ${typeof obj[key]}).`,
    tool,
    phase: "parse_arguments",
    details: { field: key, expected, received: obj[key] },
    retryable: false
  });
}

export function optString(obj: Record<string, unknown>, key: string, tool?: ToolName): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") rejectWrongType(obj, key, "a string", tool);
  return v || undefined; // empty string treated as omitted; matches pre-strict behavior
}

export function optNumber(obj: Record<string, unknown>, key: string, tool?: ToolName): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) rejectWrongType(obj, key, "a finite number", tool);
  return v;
}

export function optBool(obj: Record<string, unknown>, key: string, tool?: ToolName): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") rejectWrongType(obj, key, "a boolean", tool);
  return v;
}

// Target-selector triple is shared across most tools.
export interface TargetArgs {
  tabId?: number;
  workspaceName?: string;
  groupName?: string;
}

// Strict version: present-but-wrong-type rejects. tabId as a string is
// rejected here (callers that need string coercion — only navigate today
// — handle it themselves before calling parseTargetArgs).
export function parseTargetArgs(obj: Record<string, unknown>, tool?: ToolName): TargetArgs {
  const out: TargetArgs = {};
  if (obj.tabId !== undefined && obj.tabId !== null) {
    if (typeof obj.tabId !== "number" || !Number.isFinite(obj.tabId)) {
      rejectWrongType(obj, "tabId", "a finite number", tool);
    }
    out.tabId = obj.tabId;
  }
  if (obj.workspaceName !== undefined && obj.workspaceName !== null) {
    if (typeof obj.workspaceName !== "string") rejectWrongType(obj, "workspaceName", "a string", tool);
    if (obj.workspaceName) out.workspaceName = obj.workspaceName;
  }
  if (obj.groupName !== undefined && obj.groupName !== null) {
    if (typeof obj.groupName !== "string") rejectWrongType(obj, "groupName", "a string", tool);
    if (obj.groupName) out.groupName = obj.groupName;
  }
  return out;
}
