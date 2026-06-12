import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  parseChromeBatchArgs,
  parseChromeGetArgs,
  parseChromeWaitArgs,
  RelayError
} from "../src/index";

const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RelayError);
    expect((e as RelayError).code).toBe("invalid_arguments");
    return;
  }
  throw new Error("expected invalid_arguments");
};

describe("parseChromeWaitArgs", () => {
  it("accepts exactly one condition", () => {
    expect(parseChromeWaitArgs({ selector: ".x", tabId: 1 })).toEqual({
      tabId: 1,
      condition: { kind: "selector", selector: ".x" },
      timeoutMs: DEFAULT_WAIT_TIMEOUT_MS
    });
    expect(parseChromeWaitArgs({ ref: "e3" }).condition).toEqual({ kind: "ref", ref: "e3" });
    expect(parseChromeWaitArgs({ text: "Welcome" }).condition).toEqual({ kind: "text", text: "Welcome" });
    expect(parseChromeWaitArgs({ urlGlob: "**/dash" }).condition).toEqual({ kind: "url", urlGlob: "**/dash" });
    expect(parseChromeWaitArgs({ load: "networkidle" }).condition).toEqual({ kind: "load", state: "networkidle" });
    expect(parseChromeWaitArgs({ fn: "window.ready" }).condition).toEqual({ kind: "fn", fn: "window.ready" });
  });

  it("rejects zero or two conditions, and bad load states", () => {
    invalid(() => parseChromeWaitArgs({}));
    invalid(() => parseChromeWaitArgs({ selector: ".x", text: "y" }));
    invalid(() => parseChromeWaitArgs({ load: "idle" }));
  });

  it("caps timeoutMs below the transport timeout", () => {
    expect(parseChromeWaitArgs({ text: "x", timeoutMs: 60_000 }).timeoutMs).toBe(MAX_WAIT_TIMEOUT_MS);
    expect(parseChromeWaitArgs({ text: "x", timeoutMs: 500 }).timeoutMs).toBe(500);
  });
});

describe("parseChromeBatchArgs", () => {
  it("parses commands with bail defaulting true", () => {
    const r = parseChromeBatchArgs({ commands: [{ name: "chrome_navigate", args: { url: "u" } }] });
    expect(r.bail).toBe(true);
    expect(r.commands[0]).toEqual({ name: "chrome_navigate", args: { url: "u" } });
  });

  it("rejects empty, oversized, and nested batches", () => {
    invalid(() => parseChromeBatchArgs({ commands: [] }));
    invalid(() => parseChromeBatchArgs({ commands: Array.from({ length: 51 }, () => ({ name: "chrome_navigate" })) }));
    invalid(() => parseChromeBatchArgs({ commands: [{ name: "chrome_batch" }] }));
  });
});

describe("parseChromeGetArgs", () => {
  it("title/url need no target element", () => {
    expect(parseChromeGetArgs({ what: "title", tabId: 2 })).toEqual({ what: "title", tabId: 2 });
    expect(parseChromeGetArgs({ what: "url" })).toEqual({ what: "url" });
  });

  it("count requires a selector; text/value take exactly one of selector|ref", () => {
    invalid(() => parseChromeGetArgs({ what: "count" }));
    expect(parseChromeGetArgs({ what: "count", selector: ".r" })).toEqual({ what: "count", selector: ".r" });
    invalid(() => parseChromeGetArgs({ what: "text" }));
    invalid(() => parseChromeGetArgs({ what: "text", selector: ".x", ref: "e1" }));
    expect(parseChromeGetArgs({ what: "value", ref: "e4" })).toEqual({ what: "value", ref: "e4", selector: undefined });
  });

  it("attr requires attrName; unknown whats reject", () => {
    invalid(() => parseChromeGetArgs({ what: "attr", ref: "e1" }));
    expect(parseChromeGetArgs({ what: "attr", ref: "e1", attrName: "href" }))
      .toEqual({ what: "attr", attrName: "href", ref: "e1", selector: undefined });
    invalid(() => parseChromeGetArgs({ what: "html" }));
  });
});
