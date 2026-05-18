// chrome_network arg schema.
//
// Network is one of the multi-action tools (action ∈ read|clear|har|body).
// The parser dispatches on action and validates only the fields each
// action needs. This eliminates the "typeof ... === string" boilerplate
// the handler used to do per-action, AND removes the silent-default risk
// (`action` defaulting to "read" on a typo).
import { RelayError, TOOL_NAMES } from "./../index";
import { asObject, optString, optNumber, optBool, optPositiveNumber, parseTargetArgs, type TargetArgs } from "./shared";

export type NetworkStatusBucket = "ok" | "redirect" | "client_error" | "server_error" | "failed";
const VALID_STATUSES: readonly NetworkStatusBucket[] = ["ok", "redirect", "client_error", "server_error", "failed"];

export interface NetworkFilter {
  filter?: string;
  status?: NetworkStatusBucket;
  method?: string;
  limit?: number;
}

export type ChromeNetworkArgs =
  | (TargetArgs & { action: "read" } & NetworkFilter)
  | (TargetArgs & { action: "clear" })
  | (TargetArgs & { action: "har"; withBodies?: boolean; bestEffortBodies?: boolean } & NetworkFilter)
  | (TargetArgs & { action: "body"; requestId: string; full?: boolean; head?: number });

function parseFilter(obj: Record<string, unknown>): NetworkFilter {
  const out: NetworkFilter = {};
  const filter = optString(obj, "filter"); if (filter)       out.filter = filter;
  const method = optString(obj, "method"); if (method)       out.method = method;
  const limit  = optNumber(obj, "limit");  if (limit !== undefined) out.limit = limit;
  const status = obj.status;
  if (status !== undefined && status !== null) {
    if (typeof status !== "string" || !(VALID_STATUSES as readonly string[]).includes(status)) {
      throw new RelayError({
        code: "invalid_arguments",
        message: `chrome_network: invalid status ${JSON.stringify(status)}. Expected one of: ${VALID_STATUSES.join(", ")}.`,
        tool: TOOL_NAMES.NETWORK,
        phase: "parse_status",
        details: { received: status, validChoices: VALID_STATUSES },
        retryable: false
      });
    }
    out.status = status as NetworkStatusBucket;
  }
  return out;
}

export function parseChromeNetworkArgs(input: unknown): ChromeNetworkArgs {
  const obj = asObject(input, TOOL_NAMES.NETWORK);
  const target = parseTargetArgs(obj);
  const rawAction = obj.action;
  const action = (typeof rawAction === "string" ? rawAction : "read");

  if (action === "clear") {
    return { ...target, action: "clear" };
  }
  if (action === "body") {
    const requestId = optString(obj, "requestId");
    if (!requestId) {
      throw new RelayError({
        code: "invalid_arguments",
        message: "chrome_network body requires `requestId` (a non-empty string).",
        tool: TOOL_NAMES.NETWORK,
        phase: "parse_arguments",
        details: { field: "requestId", received: obj.requestId },
        retryable: false
      });
    }
    const out: TargetArgs & { action: "body"; requestId: string; full?: boolean; head?: number } = {
      ...target, action: "body", requestId
    };
    const full = optBool(obj, "full"); if (full !== undefined) out.full = full;
    // head is a byte-truncation length — must be > 0. `--head -1` reaching
    // body.slice(0, -1) would silently return all-but-the-last-byte.
    const head = optPositiveNumber(obj, "head", TOOL_NAMES.NETWORK); if (head !== undefined) out.head = head;
    return out;
  }
  if (action === "har") {
    const withBodies      = optBool(obj, "withBodies");
    const bestEffortBodies = optBool(obj, "bestEffortBodies");
    return {
      ...target, action: "har",
      ...(withBodies !== undefined      ? { withBodies }      : {}),
      ...(bestEffortBodies !== undefined ? { bestEffortBodies } : {}),
      ...parseFilter(obj)
    };
  }
  if (action === "read") {
    return { ...target, action: "read", ...parseFilter(obj) };
  }
  throw new RelayError({
    code: "invalid_arguments",
    message: `chrome_network: unknown action "${action}". Expected read | clear | har | body.`,
    tool: TOOL_NAMES.NETWORK,
    phase: "parse_action",
    details: { received: action, validChoices: ["read", "clear", "har", "body"] },
    retryable: false
  });
}
