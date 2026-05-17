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

import type { ConsoleLevel } from "./console-buffer";
import type { TabGroupColor } from "./tab-groups";

// ---------------------------------------------------------------------------
// Tab IDs

export function parseTabIds(raw: unknown): number[] {
  const reject = (bad: unknown): never => {
    throw new Error(
      `chrome_group: invalid tabId ${JSON.stringify(bad)}. Expected a number or a comma-separated list of numbers.`
    );
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

// ---------------------------------------------------------------------------
// Tab-group colors

export const VALID_TAB_GROUP_COLORS: TabGroupColor[] = [
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"
];

export function parseTabGroupColor(raw: unknown): TabGroupColor | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(
      `chrome_group: invalid color ${JSON.stringify(raw)}. Expected one of: ${VALID_TAB_GROUP_COLORS.join(", ")}.`
    );
  }
  const c = raw.toLowerCase() as TabGroupColor;
  if (!VALID_TAB_GROUP_COLORS.includes(c)) {
    throw new Error(
      `chrome_group: invalid color "${raw}". Expected one of: ${VALID_TAB_GROUP_COLORS.join(", ")}.`
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
      throw new Error(
        `chrome_console: invalid level ${JSON.stringify(s)}. Expected one of: ${VALID_CONSOLE_LEVELS.join(", ")}.`
      );
    }
    return s as ConsoleLevel;
  };
  if (typeof input === "string") return input.split(",").map((s) => verify(s.trim()));
  if (Array.isArray(input))      return input.map(verify);
  throw new Error(
    `chrome_console: invalid levels argument ${JSON.stringify(input)}. Expected a comma-separated string or an array of strings.`
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
  throw new Error(
    `chrome_network: invalid status ${JSON.stringify(input)}. Expected one of: ${VALID_NETWORK_STATUSES.join(", ")}.`
  );
}
