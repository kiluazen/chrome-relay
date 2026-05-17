// Strict argument parsers — pure module, no chrome runtime imports.
//
// Rule: an explicitly-passed value that doesn't match the expected enum or
// shape MUST throw. Silent dropping is worse than failing: an agent that
// asks for `errors` (typo of `error`) and gets all levels back will reason
// wrongly about the page state. `undefined` is reserved for "the caller
// truly omitted this field" — the handler then uses its default.
//
// Lives in its own file (vs. inline in tools.ts) so the unit tests don't
// need a chrome.* mock just to exercise pure logic.
//
// All errors thrown here are RelayError with code "invalid_arguments" so
// agents can branch on `error.code === "invalid_arguments"` instead of
// regex-matching message strings.

import { RelayError, type ToolName } from "@chrome-relay/protocol";
import type { ConsoleLevel } from "./console-buffer";
import type { TabGroupColor } from "./tab-groups";

function invalidArg(tool: ToolName, message: string, phase: string, details?: Record<string, unknown>): never {
  throw new RelayError({
    code: "invalid_arguments",
    message,
    tool,
    phase,
    details,
    retryable: false
  });
}

// ---------------------------------------------------------------------------
// Tab IDs

export function parseTabIds(raw: unknown): number[] {
  const reject = (bad: unknown): never =>
    invalidArg(
      "chrome_group",
      `chrome_group: invalid tabId ${JSON.stringify(bad)}. Expected a number or a comma-separated list of numbers.`,
      "parse_tab_ids",
      { received: bad }
    );
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

// ---------------------------------------------------------------------------
// Tab-group colors

export const VALID_TAB_GROUP_COLORS: TabGroupColor[] = [
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"
];

export function parseTabGroupColor(raw: unknown): TabGroupColor | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    invalidArg(
      "chrome_group",
      `chrome_group: invalid color ${JSON.stringify(raw)}. Expected one of: ${VALID_TAB_GROUP_COLORS.join(", ")}.`,
      "parse_color",
      { received: raw, validChoices: VALID_TAB_GROUP_COLORS }
    );
  }
  const c = raw.toLowerCase() as TabGroupColor;
  if (!VALID_TAB_GROUP_COLORS.includes(c)) {
    invalidArg(
      "chrome_group",
      `chrome_group: invalid color "${raw}". Expected one of: ${VALID_TAB_GROUP_COLORS.join(", ")}.`,
      "parse_color",
      { received: raw, validChoices: VALID_TAB_GROUP_COLORS }
    );
  }
  return c;
}

// ---------------------------------------------------------------------------
// Console levels

export const VALID_CONSOLE_LEVELS: ConsoleLevel[] = [
  "log", "info", "warn", "error", "debug", "exception"
];

export function parseLevels(input: unknown): ConsoleLevel[] | undefined {
  if (input === undefined || input === null) return undefined;
  const valid = new Set<ConsoleLevel>(VALID_CONSOLE_LEVELS);
  const verify = (s: unknown): ConsoleLevel => {
    if (typeof s !== "string" || !valid.has(s as ConsoleLevel)) {
      invalidArg(
        "chrome_console",
        `chrome_console: invalid level ${JSON.stringify(s)}. Expected one of: ${VALID_CONSOLE_LEVELS.join(", ")}.`,
        "parse_levels",
        { received: s, validChoices: VALID_CONSOLE_LEVELS }
      );
    }
    return s as ConsoleLevel;
  };
  if (typeof input === "string") return input.split(",").map((s) => verify(s.trim()));
  if (Array.isArray(input))      return input.map(verify);
  invalidArg(
    "chrome_console",
    `chrome_console: invalid levels argument ${JSON.stringify(input)}. Expected a comma-separated string or an array of strings.`,
    "parse_levels",
    { received: input }
  );
}

// ---------------------------------------------------------------------------
// Network status buckets

export const VALID_NETWORK_STATUSES = ["ok", "redirect", "client_error", "server_error", "failed"] as const;
export type NetworkStatus = typeof VALID_NETWORK_STATUSES[number];

export function parseNetworkStatus(input: unknown): NetworkStatus | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string" && (VALID_NETWORK_STATUSES as readonly string[]).includes(input)) {
    return input as NetworkStatus;
  }
  invalidArg(
    "chrome_network",
    `chrome_network: invalid status ${JSON.stringify(input)}. Expected one of: ${VALID_NETWORK_STATUSES.join(", ")}.`,
    "parse_status",
    { received: input, validChoices: VALID_NETWORK_STATUSES }
  );
}
