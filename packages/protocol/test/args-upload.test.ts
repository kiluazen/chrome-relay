import { describe, it, expect } from "vitest";
import { parseChromeUploadArgs } from "../src/args/upload";
import { RelayError } from "../src/index";
import {
  parseRefToken,
  splitRefId,
  qualifyRefId,
  instancePrefix,
  collectRefPrefixes
} from "../src/snapshot";

const FILES = ["/tmp/a.pdf"];

function relayCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RelayError) return e.code;
    throw e;
  }
  throw new Error("expected a RelayError");
}

describe("parseChromeUploadArgs", () => {
  it("parses action=set with a ref", () => {
    const parsed = parseChromeUploadArgs({ action: "set", ref: "3f2a:e12", files: FILES, tabId: 5 });
    expect(parsed).toEqual({ action: "set", ref: "3f2a:e12", files: FILES, tabId: 5 });
  });

  it("parses action=choose with clickSelector and timeoutMs", () => {
    const parsed = parseChromeUploadArgs({
      action: "choose", clickSelector: "#upload-btn", files: FILES, timeoutMs: 4000
    });
    expect(parsed).toEqual({ action: "choose", clickSelector: "#upload-btn", files: FILES, timeoutMs: 4000 });
  });

  it("parses action=drop with a selector", () => {
    const parsed = parseChromeUploadArgs({ action: "drop", selector: ".dropzone", files: FILES });
    expect(parsed).toEqual({ action: "drop", selector: ".dropzone", files: FILES });
  });

  it("rejects unknown actions", () => {
    expect(relayCode(() => parseChromeUploadArgs({ action: "auto", ref: "e1", files: FILES })))
      .toBe("invalid_arguments");
  });

  it("rejects empty or non-string files", () => {
    expect(relayCode(() => parseChromeUploadArgs({ action: "set", ref: "e1", files: [] })))
      .toBe("invalid_arguments");
    expect(relayCode(() => parseChromeUploadArgs({ action: "set", ref: "e1", files: [42] })))
      .toBe("invalid_arguments");
    expect(relayCode(() => parseChromeUploadArgs({ action: "set", ref: "e1" })))
      .toBe("invalid_arguments");
  });

  it("requires exactly one target: none, or both ref+selector, reject", () => {
    expect(relayCode(() => parseChromeUploadArgs({ action: "set", files: FILES })))
      .toBe("invalid_arguments");
    expect(relayCode(() => parseChromeUploadArgs({ action: "set", ref: "e1", selector: "#x", files: FILES })))
      .toBe("invalid_arguments");
  });

  it("rejects choose-only fields on set/drop and vice versa", () => {
    expect(relayCode(() => parseChromeUploadArgs({ action: "set", ref: "e1", clickRef: "e2", files: FILES })))
      .toBe("invalid_arguments");
    expect(relayCode(() => parseChromeUploadArgs({ action: "set", ref: "e1", timeoutMs: 100, files: FILES })))
      .toBe("invalid_arguments");
    expect(relayCode(() => parseChromeUploadArgs({ action: "choose", ref: "e1", files: FILES })))
      .toBe("invalid_arguments");
    expect(relayCode(() => parseChromeUploadArgs({ action: "choose", clickRef: "e1", clickSelector: "#x", files: FILES })))
      .toBe("invalid_arguments");
  });
});

describe("qualified ref tokens (v2)", () => {
  it("parseRefToken accepts bare and qualified forms", () => {
    expect(parseRefToken("@e3")).toBe("e3");
    expect(parseRefToken("@3f2a:e12")).toBe("3f2a:e12");
    expect(parseRefToken(" @3f2a:e12 ")).toBe("3f2a:e12");
  });

  it("parseRefToken rejects non-ref shapes", () => {
    expect(parseRefToken("e3")).toBeNull();          // no @ — CSS selector territory
    expect(parseRefToken("@x1")).toBeNull();
    expect(parseRefToken("@3f2a:")).toBeNull();
    expect(parseRefToken("@ZZZZ:e3")).toBeNull();    // prefix must be lowercase hex
    expect(parseRefToken("@abc:e3")).toBeNull();     // prefix minimum 4 chars
  });

  it("splitRefId separates prefix and local id", () => {
    expect(splitRefId("3f2a:e12")).toEqual({ prefix: "3f2a", id: "e12" });
    expect(splitRefId("e12")).toEqual({ prefix: null, id: "e12" });
    expect(splitRefId("nonsense")).toBeNull();
  });

  it("qualifyRefId and instancePrefix round-trip with the token grammar", () => {
    const prefix = instancePrefix("3f2a9c1e-0000-4000-8000-000000000000");
    expect(prefix).toBe("3f2a");
    const id = qualifyRefId("e7", prefix);
    expect(id).toBe("3f2a:e7");
    expect(parseRefToken(`@${id}`)).toBe(id);
    expect(splitRefId(id)).toEqual({ prefix: "3f2a", id: "e7" });
  });

  it("collectRefPrefixes reads only ref-bearing keys, recursively", () => {
    const prefixes = collectRefPrefixes({
      ref: "3f2a:e1",
      value: "91bc:e9", // user data that LOOKS like a ref — must be ignored
      calls: [{ args: { clickRef: "3f2a:e4" } }, { args: { ref: "e2" } }] // bare adds nothing
    });
    expect([...prefixes]).toEqual(["3f2a"]);
  });

  it("collectRefPrefixes surfaces cross-profile conflicts", () => {
    const prefixes = collectRefPrefixes({
      calls: [{ args: { ref: "3f2a:e1" } }, { args: { ref: "91bc:e2" } }]
    });
    expect(prefixes.size).toBe(2);
  });
});
