// PR 0 of code-quality-hardening: strict input parsers.
//
// Rule under test: when an explicit value is passed that doesn't match the
// expected enum or shape, the parser MUST throw. Silent dropping (the old
// behavior) lets an agent typo their way into a wrong answer — e.g. asking
// for `errors` (typo) and silently getting all levels back.
//
// `undefined` is the one exception: it means the caller truly omitted the
// field, and the handler uses its default.

import { describe, it, expect } from "vitest";
import { RelayError } from "@chrome-relay/protocol";
import {
  parseTabIds,
  parseTabGroupColor,
  VALID_TAB_GROUP_COLORS,
  parseLevels,
  VALID_CONSOLE_LEVELS,
  parseNetworkStatus,
  VALID_NETWORK_STATUSES
} from "../src/browser/parsers";

// Helper: assert the thrown error is a RelayError with code:"invalid_arguments"
// and the expected tool. PR 1 of code-quality-hardening — structured errors.
function expectInvalidArguments(fn: () => unknown, tool: string): RelayError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RelayError);
  const err = caught as RelayError;
  expect(err.code).toBe("invalid_arguments");
  expect(err.tool).toBe(tool);
  return err;
}

describe("parseTabIds", () => {
  it("accepts a number", () => {
    expect(parseTabIds(42)).toEqual([42]);
  });

  it("accepts an array of numbers", () => {
    expect(parseTabIds([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("accepts a comma-separated string", () => {
    expect(parseTabIds("1,2,3")).toEqual([1, 2, 3]);
    expect(parseTabIds(" 10, 20 , 30 ")).toEqual([10, 20, 30]);
  });

  it("returns [] when the field is truly omitted", () => {
    expect(parseTabIds(undefined)).toEqual([]);
    expect(parseTabIds(null)).toEqual([]);
  });

  it("throws on a non-numeric element in a string list", () => {
    expect(() => parseTabIds("1,foo,3")).toThrow(/invalid tabId.*"foo"/);
  });

  it("throws on a non-numeric element in an array", () => {
    expect(() => parseTabIds([1, "not-a-number", 3])).toThrow(/invalid tabId/);
  });

  it("does NOT silently drop bad survivors", () => {
    // The old behavior would have returned [1, 3]. The strict behavior throws.
    expect(() => parseTabIds("1,foo,3")).toThrow();
  });
});

describe("parseTabGroupColor", () => {
  it("accepts every valid color and lowercases input", () => {
    for (const color of VALID_TAB_GROUP_COLORS) {
      expect(parseTabGroupColor(color)).toBe(color);
      expect(parseTabGroupColor(color.toUpperCase())).toBe(color);
    }
  });

  it("returns undefined when the field is truly omitted", () => {
    expect(parseTabGroupColor(undefined)).toBeUndefined();
    expect(parseTabGroupColor(null)).toBeUndefined();
  });

  it("throws on an unknown color string", () => {
    expect(() => parseTabGroupColor("magenta")).toThrow(/invalid color "magenta"/);
    expect(() => parseTabGroupColor("blu")).toThrow(/invalid color "blu"/);
  });

  it("throws on a non-string value", () => {
    expect(() => parseTabGroupColor(42)).toThrow(/invalid color/);
    expect(() => parseTabGroupColor({})).toThrow(/invalid color/);
  });

  it("lists the valid choices in the error message", () => {
    expect(() => parseTabGroupColor("rainbow")).toThrow(/grey, blue, red, yellow, green/);
  });
});

describe("parseLevels", () => {
  it("accepts every valid level via string and via array", () => {
    expect(parseLevels("error")).toEqual(["error"]);
    expect(parseLevels("error,warn")).toEqual(["error", "warn"]);
    expect(parseLevels(["log", "info"])).toEqual(["log", "info"]);
  });

  it("returns undefined when the field is truly omitted", () => {
    expect(parseLevels(undefined)).toBeUndefined();
    expect(parseLevels(null)).toBeUndefined();
  });

  it("throws on a typoed level (was silently dropped before)", () => {
    // "errors" is a common typo of "error" — the OLD behavior would return
    // ALL levels because the filter array was empty after the drop.
    expect(() => parseLevels("errors")).toThrow(/invalid level.*"errors"/);
  });

  it("throws on a mixed list with one bad value", () => {
    expect(() => parseLevels("error,debug,bogus")).toThrow(/invalid level/);
    expect(() => parseLevels(["error", 123])).toThrow(/invalid level/);
  });

  it("throws on a non-string/non-array argument", () => {
    expect(() => parseLevels(42)).toThrow(/invalid levels argument/);
    expect(() => parseLevels({ level: "error" })).toThrow(/invalid levels argument/);
  });

  it("lists valid choices in the error message", () => {
    expect(() => parseLevels("trace")).toThrow(/log, info, warn, error, debug, exception/);
  });

  it("exposes every valid level via VALID_CONSOLE_LEVELS", () => {
    expect(VALID_CONSOLE_LEVELS).toEqual(["log", "info", "warn", "error", "debug", "exception"]);
  });

  it("throws RelayError with code invalid_arguments + tool chrome_console", () => {
    const err = expectInvalidArguments(() => parseLevels("errors"), "chrome_console");
    expect(err.phase).toBe("parse_levels");
    expect(err.details?.received).toBe("errors");
    expect(err.details?.validChoices).toEqual(VALID_CONSOLE_LEVELS);
  });
});

describe("parseNetworkStatus", () => {
  it("accepts every valid status", () => {
    for (const s of VALID_NETWORK_STATUSES) {
      expect(parseNetworkStatus(s)).toBe(s);
    }
  });

  it("returns undefined when the field is truly omitted", () => {
    expect(parseNetworkStatus(undefined)).toBeUndefined();
    expect(parseNetworkStatus(null)).toBeUndefined();
  });

  it("throws on a typoed status (was silently passed through before)", () => {
    expect(() => parseNetworkStatus("clients_error")).toThrow(/invalid status/);
    expect(() => parseNetworkStatus("OK")).toThrow(/invalid status.*"OK"/);
  });

  it("throws on a non-string value", () => {
    expect(() => parseNetworkStatus(404)).toThrow(/invalid status/);
  });

  it("lists valid choices in the error message", () => {
    expect(() => parseNetworkStatus("nope")).toThrow(/ok, redirect, client_error, server_error, failed/);
  });

  it("throws RelayError with code invalid_arguments + tool chrome_network", () => {
    const err = expectInvalidArguments(() => parseNetworkStatus("clients_error"), "chrome_network");
    expect(err.phase).toBe("parse_status");
    expect(err.details?.received).toBe("clients_error");
  });
});

describe("Structured error codes for the other parsers", () => {
  it("parseTabIds throws RelayError with tool chrome_group", () => {
    const err = expectInvalidArguments(() => parseTabIds("1,foo,3"), "chrome_group");
    expect(err.phase).toBe("parse_tab_ids");
    expect(err.details?.received).toBe("foo");
  });

  it("parseTabGroupColor throws RelayError with tool chrome_group", () => {
    const err = expectInvalidArguments(() => parseTabGroupColor("magenta"), "chrome_group");
    expect(err.phase).toBe("parse_color");
    expect(err.details?.received).toBe("magenta");
  });
});
