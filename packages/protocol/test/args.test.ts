// Tool-arg parser tests (code-quality-hardening PR 12).
//
// Each parser is the single source of truth for what a tool accepts. These
// tests pin valid + invalid shapes so future CLI/extension consumers can't
// drift away from the contract.

import { describe, it, expect } from "vitest";
import {
  RelayError,
  parseChromeNavigateArgs,
  parseChromeHoverArgs,
  parseChromeNetworkArgs
} from "../src/index";

function expectInvalidArguments(fn: () => unknown): RelayError {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(RelayError);
  const err = caught as RelayError;
  expect(err.code).toBe("invalid_arguments");
  return err;
}

describe("parseChromeNavigateArgs", () => {
  it("accepts the minimum valid shape", () => {
    expect(parseChromeNavigateArgs({ url: "https://example.com" }))
      .toEqual({ url: "https://example.com" });
  });

  it("preserves tabId / workspaceName / groupName target fields", () => {
    expect(parseChromeNavigateArgs({ url: "https://x.com", tabId: 42 }))
      .toEqual({ url: "https://x.com", tabId: 42 });
    expect(parseChromeNavigateArgs({ url: "https://x.com", workspaceName: "ws" }))
      .toEqual({ url: "https://x.com", workspaceName: "ws" });
    expect(parseChromeNavigateArgs({ url: "https://x.com", groupName: "g" }))
      .toEqual({ url: "https://x.com", groupName: "g" });
  });

  it("accepts string tabId and coerces to number (back-compat with --new reference)", () => {
    expect(parseChromeNavigateArgs({ url: "https://x.com", tabId: "42" }))
      .toEqual({ url: "https://x.com", tabId: 42 });
  });

  it("forwards newTab / active / allowPartial flags", () => {
    expect(parseChromeNavigateArgs({ url: "https://x.com", newTab: true, active: false, allowPartial: true }))
      .toEqual({ url: "https://x.com", newTab: true, active: false, allowPartial: true });
  });

  it("throws invalid_arguments when url is missing", () => {
    expectInvalidArguments(() => parseChromeNavigateArgs({}));
    expectInvalidArguments(() => parseChromeNavigateArgs({ url: "" }));
    expectInvalidArguments(() => parseChromeNavigateArgs({ tabId: 1 }));
  });

  it("throws invalid_arguments on non-object input", () => {
    expectInvalidArguments(() => parseChromeNavigateArgs(null));
    expectInvalidArguments(() => parseChromeNavigateArgs("https://x.com"));
    expectInvalidArguments(() => parseChromeNavigateArgs([{ url: "https://x.com" }]));
  });

  // Post-0.5.14: optional fields are strict — present-but-wrong-type rejects.
  it("throws invalid_arguments when newTab/active/allowPartial aren't booleans", () => {
    expectInvalidArguments(() => parseChromeNavigateArgs({ url: "https://x.com", newTab: "yes" }));
    expectInvalidArguments(() => parseChromeNavigateArgs({ url: "https://x.com", active: 1 }));
    expectInvalidArguments(() => parseChromeNavigateArgs({ url: "https://x.com", allowPartial: "true" }));
  });

  it("throws invalid_arguments when workspaceName/groupName aren't strings", () => {
    expectInvalidArguments(() => parseChromeNavigateArgs({ url: "https://x.com", workspaceName: 5 }));
    expectInvalidArguments(() => parseChromeNavigateArgs({ url: "https://x.com", groupName: true }));
  });
});

describe("parseChromeHoverArgs", () => {
  it("accepts selector form", () => {
    const r = parseChromeHoverArgs({ selector: "button.primary" });
    expect(r).toEqual({ kind: "selector", selector: "button.primary" });
  });

  it("accepts coords form", () => {
    const r = parseChromeHoverArgs({ x: 10, y: 20 });
    expect(r).toEqual({ kind: "coords", x: 10, y: 20 });
  });

  it("prefers coords when both selector and x,y are provided", () => {
    const r = parseChromeHoverArgs({ selector: "b", x: 1, y: 2 });
    expect(r.kind).toBe("coords");
  });

  it("preserves target fields on both forms", () => {
    expect(parseChromeHoverArgs({ selector: "b", tabId: 7 }))
      .toEqual({ kind: "selector", selector: "b", tabId: 7 });
    expect(parseChromeHoverArgs({ x: 1, y: 2, workspaceName: "ws" }))
      .toEqual({ kind: "coords", x: 1, y: 2, workspaceName: "ws" });
  });

  it("throws invalid_arguments when neither selector nor x,y is provided", () => {
    expectInvalidArguments(() => parseChromeHoverArgs({}));
    expectInvalidArguments(() => parseChromeHoverArgs({ x: 1 }));  // missing y
    expectInvalidArguments(() => parseChromeHoverArgs({ y: 2 }));  // missing x
    expectInvalidArguments(() => parseChromeHoverArgs({ selector: "" })); // empty string
  });
});

describe("parseChromeNetworkArgs", () => {
  it("defaults action to read when omitted", () => {
    const r = parseChromeNetworkArgs({});
    expect(r.action).toBe("read");
  });

  it("read with filters", () => {
    const r = parseChromeNetworkArgs({
      action: "read",
      filter: "api.example.com",
      status: "failed",
      method: "POST",
      limit: 50
    });
    expect(r).toEqual({
      action: "read",
      filter: "api.example.com",
      status: "failed",
      method: "POST",
      limit: 50
    });
  });

  it("clear shape", () => {
    expect(parseChromeNetworkArgs({ action: "clear", tabId: 1 }))
      .toEqual({ action: "clear", tabId: 1 });
  });

  it("har with bodies + best-effort flags", () => {
    const r = parseChromeNetworkArgs({
      action: "har",
      withBodies: true,
      bestEffortBodies: true
    });
    expect(r).toEqual({ action: "har", withBodies: true, bestEffortBodies: true });
  });

  it("body requires requestId", () => {
    expectInvalidArguments(() => parseChromeNetworkArgs({ action: "body" }));
    expectInvalidArguments(() => parseChromeNetworkArgs({ action: "body", requestId: "" }));
    expect(parseChromeNetworkArgs({ action: "body", requestId: "req-1" }))
      .toEqual({ action: "body", requestId: "req-1" });
  });

  it("body forwards full + head", () => {
    expect(parseChromeNetworkArgs({ action: "body", requestId: "r1", full: true, head: 1024 }))
      .toEqual({ action: "body", requestId: "r1", full: true, head: 1024 });
  });

  it("throws invalid_arguments on bad status filter", () => {
    expectInvalidArguments(() => parseChromeNetworkArgs({ status: "clients_error" }));
    expectInvalidArguments(() => parseChromeNetworkArgs({ status: 404 }));
  });

  it("throws invalid_arguments on unknown action", () => {
    expectInvalidArguments(() => parseChromeNetworkArgs({ action: "purge" }));
  });
});
