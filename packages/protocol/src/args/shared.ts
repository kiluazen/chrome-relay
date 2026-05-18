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

export function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v ? v : undefined;
}

export function optNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function optBool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  return typeof v === "boolean" ? v : undefined;
}

// Target-selector triple is shared across most tools.
export interface TargetArgs {
  tabId?: number;
  workspaceName?: string;
  groupName?: string;
}

export function parseTargetArgs(obj: Record<string, unknown>): TargetArgs {
  const out: TargetArgs = {};
  if (typeof obj.tabId === "number") out.tabId = obj.tabId;
  if (typeof obj.workspaceName === "string" && obj.workspaceName) out.workspaceName = obj.workspaceName;
  if (typeof obj.groupName === "string" && obj.groupName) out.groupName = obj.groupName;
  return out;
}
