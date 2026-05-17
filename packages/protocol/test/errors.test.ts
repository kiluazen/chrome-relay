import { describe, it, expect } from "vitest";
import {
  RelayError,
  toBridgeError,
  type BridgeError,
  type BridgeNotice
} from "../src/index";

describe("RelayError", () => {
  it("preserves all fields and is instanceof Error", () => {
    const err = new RelayError({
      code: "element_not_found",
      message: "Element not found for selector .foo",
      tool: "chrome_click_element",
      phase: "locate_element",
      details: { selector: ".foo" },
      retryable: false
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.code).toBe("element_not_found");
    expect(err.message).toBe("Element not found for selector .foo");
    expect(err.tool).toBe("chrome_click_element");
    expect(err.phase).toBe("locate_element");
    expect(err.details).toEqual({ selector: ".foo" });
    expect(err.retryable).toBe(false);
  });

  it("serializes to a BridgeError with the same shape", () => {
    const err = new RelayError({
      code: "invalid_arguments",
      message: "bad",
      tool: "chrome_console",
      phase: "parse_levels"
    });
    const wire: BridgeError = err.toBridgeError();
    expect(wire).toEqual({
      code: "invalid_arguments",
      message: "bad",
      tool: "chrome_console",
      phase: "parse_levels"
    });
  });

  it("toBridgeError() omits undefined optional fields", () => {
    const err = new RelayError({ code: "internal_error", message: "boom" });
    const wire = err.toBridgeError();
    expect(wire).toEqual({ code: "internal_error", message: "boom" });
    expect(wire).not.toHaveProperty("tool");
    expect(wire).not.toHaveProperty("phase");
  });
});

describe("toBridgeError (boundary wrapper)", () => {
  it("passes RelayError through unchanged", () => {
    const err = new RelayError({
      code: "target_not_found",
      message: "no tab 42",
      tool: "chrome_screenshot"
    });
    const wire = toBridgeError(err);
    expect(wire).toEqual({
      code: "target_not_found",
      message: "no tab 42",
      tool: "chrome_screenshot"
    });
  });

  it("falls back to internal_error for plain Error", () => {
    const wire = toBridgeError(new Error("plain bang"));
    expect(wire).toEqual({ code: "internal_error", message: "plain bang" });
  });

  it("falls back to internal_error with String() for non-Error throws", () => {
    expect(toBridgeError("string thrown")).toEqual({ code: "internal_error", message: "string thrown" });
    expect(toBridgeError(42)).toEqual({ code: "internal_error", message: "42" });
  });

  it("annotates fallbackTool when missing", () => {
    const wire = toBridgeError(new Error("oops"), "chrome_click_element");
    expect(wire).toEqual({
      code: "internal_error",
      message: "oops",
      tool: "chrome_click_element"
    });
  });

  it("does not override an existing tool on a RelayError", () => {
    const err = new RelayError({
      code: "cdp_error",
      message: "x",
      tool: "chrome_screenshot"
    });
    const wire = toBridgeError(err, "chrome_console");
    expect(wire.tool).toBe("chrome_screenshot");
  });
});

describe("BridgeNotice shape (compile-only smoke)", () => {
  it("accepts the cli_outdated notice shape used by the HTTP server", () => {
    const notice: BridgeNotice = {
      code: "cli_outdated",
      message: "cli-outdated: 0.5.2 < extension 0.5.3; run `chrome-relay update`",
      details: { currentVersion: "0.5.2", expectedVersion: "0.5.3" },
      action: { command: "chrome-relay update" }
    };
    expect(notice.code).toBe("cli_outdated");
  });
});
