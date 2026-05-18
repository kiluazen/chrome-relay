// Code-quality-hardening final coverage: every tool's protocol parser
// gets at least one valid + one invalid case. Companion to args.test.ts
// (which exhaustively covers navigate/hover/network).

import { describe, it, expect } from "vitest";
import {
  RelayError,
  parseGetWindowsAndTabsArgs,
  parseChromeSelfReloadArgs,
  parseChromeReadPageArgs,
  parseChromeClickArgs,
  parseChromeFillArgs,
  parseChromeKeyboardArgs,
  parseChromeTypeArgs,
  parseChromeEvaluateArgs,
  parseChromeSwitchTabArgs,
  parseChromeCloseTabsArgs,
  parseChromeAxArgs,
  parseChromeClickAxArgs,
  parseChromeScreenshotArgs,
  parseChromeViewportArgs,
  parseChromeConsoleArgs,
  parseChromeNetworkArgs,
  parseChromeWorkspaceArgs,
  parseChromeGroupArgs,
  parseChromeScreencastArgs
} from "../src/index";

function expectInvalid(fn: () => unknown): RelayError {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(RelayError);
  expect((caught as RelayError).code).toBe("invalid_arguments");
  return caught as RelayError;
}

describe("simple-tool parsers", () => {
  it("get_windows_and_tabs / self_reload accept anything (no args)", () => {
    expect(parseGetWindowsAndTabsArgs({})).toEqual({});
    expect(parseChromeSelfReloadArgs(undefined)).toEqual({});
  });

  it("read_page: optional interactiveOnly + target", () => {
    expect(parseChromeReadPageArgs({})).toEqual({});
    expect(parseChromeReadPageArgs({ interactiveOnly: true, tabId: 5 }))
      .toEqual({ interactiveOnly: true, tabId: 5 });
  });

  it("click: requires selector", () => {
    expectInvalid(() => parseChromeClickArgs({}));
    expect(parseChromeClickArgs({ selector: ".foo", tabId: 1 }))
      .toEqual({ selector: ".foo", tabId: 1 });
  });

  it("fill: requires selector + string value (empty allowed)", () => {
    expectInvalid(() => parseChromeFillArgs({ selector: ".foo" }));        // missing value
    expectInvalid(() => parseChromeFillArgs({ value: "x" }));               // missing selector
    expectInvalid(() => parseChromeFillArgs({ selector: ".f", value: 1 })); // value not string
    expect(parseChromeFillArgs({ selector: ".f", value: "" }))
      .toEqual({ selector: ".f", value: "" }); // empty is OK
    expect(parseChromeFillArgs({ selector: ".f", value: "hi" }))
      .toEqual({ selector: ".f", value: "hi" });
  });

  it("keyboard: requires keys", () => {
    expectInvalid(() => parseChromeKeyboardArgs({}));
    expect(parseChromeKeyboardArgs({ keys: "Enter" }))
      .toEqual({ keys: "Enter" });
  });

  it("type: requires text, selector is optional", () => {
    expectInvalid(() => parseChromeTypeArgs({}));
    expect(parseChromeTypeArgs({ text: "hi" })).toEqual({ text: "hi" });
    expect(parseChromeTypeArgs({ text: "hi", selector: ".x" }))
      .toEqual({ text: "hi", selector: ".x" });
  });

  it("evaluate: requires code, optional timeoutMs", () => {
    expectInvalid(() => parseChromeEvaluateArgs({}));
    expect(parseChromeEvaluateArgs({ code: "return 1" })).toEqual({ code: "return 1" });
    expect(parseChromeEvaluateArgs({ code: "return 1", timeoutMs: 5000 }))
      .toEqual({ code: "return 1", timeoutMs: 5000 });
  });

  it("switch_tab: requires numeric tabId", () => {
    expectInvalid(() => parseChromeSwitchTabArgs({}));
    expectInvalid(() => parseChromeSwitchTabArgs({ tabId: "abc" }));
    expect(parseChromeSwitchTabArgs({ tabId: 42 })).toEqual({ tabId: 42 });
    // string-numeric coerces (back-compat with shell quoting)
    expect(parseChromeSwitchTabArgs({ tabId: "42" })).toEqual({ tabId: 42 });
  });

  it("close_tabs: requires non-empty numeric array", () => {
    expectInvalid(() => parseChromeCloseTabsArgs({}));
    expectInvalid(() => parseChromeCloseTabsArgs({ tabIds: [] }));
    expectInvalid(() => parseChromeCloseTabsArgs({ tabIds: ["foo"] }));
    expect(parseChromeCloseTabsArgs({ tabIds: [1, 2, 3] })).toEqual({ tabIds: [1, 2, 3] });
    // String elements coerce
    expect(parseChromeCloseTabsArgs({ tabIds: ["1", "2"] })).toEqual({ tabIds: [1, 2] });
  });

  // Post-0.5.15: blank-string / whitespace-only tab IDs reject instead of
  // silently coercing to 0 (Number("") === 0 → would target tab 0).
  it("close_tabs: rejects empty + whitespace-only string ids (was silent 0)", () => {
    expectInvalid(() => parseChromeCloseTabsArgs({ tabIds: [""] }));
    expectInvalid(() => parseChromeCloseTabsArgs({ tabIds: [" "] }));
    expectInvalid(() => parseChromeCloseTabsArgs({ tabIds: [1, "", 3] }));
  });

  it("switch_tab: rejects empty + whitespace-only string ids", () => {
    expectInvalid(() => parseChromeSwitchTabArgs({ tabId: "" }));
    expectInvalid(() => parseChromeSwitchTabArgs({ tabId: " " }));
  });

  it("ax: all fields optional", () => {
    expect(parseChromeAxArgs({})).toEqual({});
    expect(parseChromeAxArgs({ interactiveOnly: true, rootRole: "main", includeSubframes: true, tabId: 1 }))
      .toEqual({ interactiveOnly: true, rootRole: "main", includeSubframes: true, tabId: 1 });
  });

  it("click_ax: requires positive numeric node (accepts `id` alias)", () => {
    expectInvalid(() => parseChromeClickAxArgs({}));
    expectInvalid(() => parseChromeClickAxArgs({ node: 0 }));
    expectInvalid(() => parseChromeClickAxArgs({ node: -1 }));
    expect(parseChromeClickAxArgs({ node: 42 })).toEqual({ node: 42 });
    expect(parseChromeClickAxArgs({ id: 42 })).toEqual({ node: 42 });
  });

  it("screenshot: all fields optional", () => {
    expect(parseChromeScreenshotArgs({})).toEqual({});
    const r = parseChromeScreenshotArgs({
      fullPage: true, bbox: "0,0,100,100", selector: ".x", padding: 8, maxEdge: 1024, tabId: 1
    });
    expect(r).toEqual({
      fullPage: true, bbox: "0,0,100,100", selector: ".x", padding: 8, maxEdge: 1024, tabId: 1
    });
  });

  // Post-0.5.15: ranged numeric fields reject out-of-range values instead
  // of silently dropping them (maxEdge <= 0) or letting them pass through
  // to CDP/handler logic with nonsense semantics.
  it("screenshot: maxEdge <= 0 rejects (was silently ignored)", () => {
    expectInvalid(() => parseChromeScreenshotArgs({ maxEdge: 0 }));
    expectInvalid(() => parseChromeScreenshotArgs({ maxEdge: -1 }));
  });

  it("screenshot: padding < 0 rejects", () => {
    expectInvalid(() => parseChromeScreenshotArgs({ padding: -5 }));
    // padding === 0 is valid (no pad)
    expect(parseChromeScreenshotArgs({ padding: 0 })).toEqual({ padding: 0 });
  });

  it("evaluate: timeoutMs <= 0 rejects (no-op timeout makes no sense)", () => {
    expectInvalid(() => parseChromeEvaluateArgs({ code: "return 1", timeoutMs: 0 }));
    expectInvalid(() => parseChromeEvaluateArgs({ code: "return 1", timeoutMs: -100 }));
  });
});

describe("multi-action parsers — viewport", () => {
  it("list", () => {
    expect(parseChromeViewportArgs({ action: "list" })).toEqual({ action: "list" });
  });

  it("clear with target", () => {
    expect(parseChromeViewportArgs({ action: "clear", tabId: 5 }))
      .toEqual({ action: "clear", tabId: 5 });
  });

  it("preset requires name", () => {
    expectInvalid(() => parseChromeViewportArgs({ action: "preset" }));
    expect(parseChromeViewportArgs({ action: "preset", name: "iphone-14" }))
      .toEqual({ action: "preset", name: "iphone-14" });
  });

  it("set requires positive width + height", () => {
    expectInvalid(() => parseChromeViewportArgs({ action: "set" }));
    expectInvalid(() => parseChromeViewportArgs({ action: "set", width: 0, height: 600 }));
    const r = parseChromeViewportArgs({ action: "set", width: 800, height: 600, dpr: 2, mobile: true, hasTouch: true });
    expect(r).toMatchObject({ action: "set", width: 800, height: 600, dpr: 2, mobile: true, hasTouch: true });
  });

  it("rejects unknown action", () => {
    expectInvalid(() => parseChromeViewportArgs({ action: "rotate" }));
  });
});

describe("multi-action parsers — console", () => {
  it("default action is read", () => {
    expect(parseChromeConsoleArgs({}).action).toBe("read");
  });

  it("clear shape", () => {
    expect(parseChromeConsoleArgs({ action: "clear", tabId: 1 }))
      .toEqual({ action: "clear", tabId: 1 });
  });

  it("read with levels + since + limit", () => {
    const r = parseChromeConsoleArgs({ action: "read", levels: "error,warn", since: 10, limit: 50 });
    expect(r).toEqual({ action: "read", levels: ["error", "warn"], since: 10, limit: 50 });
  });

  it("invalid level throws", () => {
    expectInvalid(() => parseChromeConsoleArgs({ levels: "errors" })); // typo
  });

  it("rejects unknown action", () => {
    expectInvalid(() => parseChromeConsoleArgs({ action: "tail" }));
  });
});

describe("multi-action parsers — workspace", () => {
  it("list", () => {
    expect(parseChromeWorkspaceArgs({ action: "list" })).toEqual({ action: "list" });
  });

  it("create requires name; takes optional url/label", () => {
    expectInvalid(() => parseChromeWorkspaceArgs({ action: "create" }));
    expect(parseChromeWorkspaceArgs({ action: "create", name: "ws", url: "https://x.com", label: "test" }))
      .toEqual({ action: "create", name: "ws", url: "https://x.com", label: "test" });
  });

  it("close requires name", () => {
    expectInvalid(() => parseChromeWorkspaceArgs({ action: "close" }));
    expect(parseChromeWorkspaceArgs({ action: "close", name: "ws" }))
      .toEqual({ action: "close", name: "ws" });
  });

  it("rejects unknown action", () => {
    expectInvalid(() => parseChromeWorkspaceArgs({ action: "rename" }));
  });
});

describe("multi-action parsers — group", () => {
  it("list", () => {
    expect(parseChromeGroupArgs({ action: "list" })).toEqual({ action: "list" });
  });

  it("create requires name + non-empty tabIds, accepts color/collapsed", () => {
    expectInvalid(() => parseChromeGroupArgs({ action: "create" }));
    expectInvalid(() => parseChromeGroupArgs({ action: "create", name: "g" }));  // missing tabIds
    expectInvalid(() => parseChromeGroupArgs({ action: "create", name: "g", tabIds: "1,foo" })); // bad id
    expectInvalid(() => parseChromeGroupArgs({ action: "create", name: "g", tabIds: "1", color: "magenta" }));
    const r = parseChromeGroupArgs({ action: "create", name: "g", tabIds: "1,2,3", color: "cyan", collapsed: true });
    expect(r).toEqual({ action: "create", name: "g", tabIds: [1, 2, 3], color: "cyan", collapsed: true });
  });

  it("add requires name + non-empty tabIds", () => {
    expectInvalid(() => parseChromeGroupArgs({ action: "add", name: "g" }));
    expect(parseChromeGroupArgs({ action: "add", name: "g", tabIds: [9] }))
      .toEqual({ action: "add", name: "g", tabIds: [9] });
  });

  it("remove requires tabIds", () => {
    expectInvalid(() => parseChromeGroupArgs({ action: "remove" }));
    expect(parseChromeGroupArgs({ action: "remove", tabIds: [9] }))
      .toEqual({ action: "remove", tabIds: [9] });
  });

  it("close requires name", () => {
    expectInvalid(() => parseChromeGroupArgs({ action: "close" }));
  });
});

describe("multi-action parsers — screencast", () => {
  it("stop shape", () => {
    expect(parseChromeScreencastArgs({ action: "stop", tabId: 1 }))
      .toEqual({ action: "stop", tabId: 1 });
  });

  it("default action is start", () => {
    expect(parseChromeScreencastArgs({}).action).toBe("start");
  });

  it("start with all options", () => {
    const r = parseChromeScreencastArgs({
      action: "start", format: "png", quality: 90, maxWidth: 1200, maxHeight: 800, everyNthFrame: 2
    });
    expect(r).toEqual({
      action: "start", format: "png", quality: 90, maxWidth: 1200, maxHeight: 800, everyNthFrame: 2
    });
  });

  it("rejects invalid format", () => {
    expectInvalid(() => parseChromeScreencastArgs({ action: "start", format: "webp" }));
  });

  it("rejects unknown action", () => {
    expectInvalid(() => parseChromeScreencastArgs({ action: "pause" }));
  });

  // Post-0.5.15: range validation.
  it("rejects quality outside 0-100", () => {
    expectInvalid(() => parseChromeScreencastArgs({ quality: -1 }));
    expectInvalid(() => parseChromeScreencastArgs({ quality: 101 }));
    expect((parseChromeScreencastArgs({ quality: 0 }) as { quality: number }).quality).toBe(0);
    expect((parseChromeScreencastArgs({ quality: 100 }) as { quality: number }).quality).toBe(100);
  });

  it("rejects non-positive maxWidth/maxHeight/everyNthFrame", () => {
    expectInvalid(() => parseChromeScreencastArgs({ maxWidth: 0 }));
    expectInvalid(() => parseChromeScreencastArgs({ maxHeight: -1 }));
    expectInvalid(() => parseChromeScreencastArgs({ everyNthFrame: 0 }));
  });
});

describe("network body: head range validation", () => {
  it("rejects head <= 0 (negative slice silently returned wrong bytes)", () => {
    expectInvalid(() => parseChromeNetworkArgs({ action: "body", requestId: "r1", head: 0 }));
    expectInvalid(() => parseChromeNetworkArgs({ action: "body", requestId: "r1", head: -1 }));
  });
});

describe("group: --tabs blank-string rejection", () => {
  it("rejects empty/whitespace string elements (was silent tab 0)", () => {
    expectInvalid(() => parseChromeGroupArgs({ action: "create", name: "g", tabIds: "1,,3" }));
    expectInvalid(() => parseChromeGroupArgs({ action: "create", name: "g", tabIds: "1, ,3" }));
    expectInvalid(() => parseChromeGroupArgs({ action: "add", name: "g", tabIds: [""] }));
    expectInvalid(() => parseChromeGroupArgs({ action: "remove", tabIds: ["1", "", "3"] }));
  });
});
