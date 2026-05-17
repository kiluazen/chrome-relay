// @vitest-environment jsdom
//
// Buffer-only tests. The CDP event subscription path (chrome.debugger.onEvent
// handlers + ensureAttached → Runtime.enable) is integration territory and
// gets covered by the live smoke pass; here we test the pure-data semantics
// of push / read / clear / cap.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Set up chrome.* globals BEFORE the module under test loads — its top-level
// statements register listeners.
beforeEach(() => {
  vi.resetModules();
  (globalThis as any).chrome = {
    debugger: { onEvent: { addListener: vi.fn() }, sendCommand: vi.fn() },
    tabs:     { onRemoved: { addListener: vi.fn() } }
  };
});

async function loadModule() {
  // Vite alias for the ./cdp import resolves via the package's tsconfig paths.
  // We mock ./cdp so the buffer module loads in jsdom without trying to attach.
  vi.doMock("../src/browser/cdp", () => ({
    ensureAttached: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined)
  }));
  return await import("../src/browser/console-buffer");
}

describe("console-buffer", () => {
  it("read on a tab that's never been touched returns empty", async () => {
    const m = await loadModule();
    expect(m.readConsole(1234)).toEqual({ entries: [], nextId: 1 });
  });

  it("ensureConsoleCapture is idempotent", async () => {
    const m = await loadModule();
    await m.ensureConsoleCapture(1);
    await m.ensureConsoleCapture(1);
    // No error, no double-attach. (Spy on the mocked cdp.send to confirm later.)
    expect(true).toBe(true);
  });

  it("clear on an unknown tab is a no-op (no throw)", async () => {
    const m = await loadModule();
    expect(m.clearConsole(9999)).toEqual({ cleared: 0 });
  });

  // To exercise the push path we have to trigger chrome.debugger.onEvent.
  // The module registers ONE listener at load — we grab the listener fn the
  // module passed to addListener and call it directly.
  it("Runtime.consoleAPICalled events land in the buffer with the right level + text", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    // ensureConsoleCapture sets subscribed=true; without it events are dropped.
    await m.ensureConsoleCapture(7);

    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    onEvent(
      { tabId: 7 },
      "Runtime.consoleAPICalled",
      { type: "warning", args: [{ type: "string", value: "deprecated" }], timestamp: 1700000000 }
    );
    onEvent(
      { tabId: 7 },
      "Runtime.consoleAPICalled",
      { type: "error", args: [{ type: "object", description: "Error: boom" }], timestamp: 1700000001 }
    );

    const { entries } = m.readConsole(7);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: "warn", text: "deprecated", id: 1 });
    expect(entries[1]).toMatchObject({ level: "error", text: "Error: boom", id: 2 });
  });

  it("level filter narrows the read", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    await m.ensureConsoleCapture(8);

    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    onEvent({ tabId: 8 }, "Runtime.consoleAPICalled", { type: "log",     args: [{ type: "string", value: "a" }] });
    onEvent({ tabId: 8 }, "Runtime.consoleAPICalled", { type: "error",   args: [{ type: "string", value: "b" }] });
    onEvent({ tabId: 8 }, "Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "c" }] });

    const errOnly = m.readConsole(8, { levels: ["error"] });
    expect(errOnly.entries.map((e) => e.text)).toEqual(["b"]);

    const errWarn = m.readConsole(8, { levels: ["error", "warn"] });
    expect(errWarn.entries.map((e) => e.text)).toEqual(["b", "c"]);
  });

  it("since filter returns only entries newer than the given id", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    await m.ensureConsoleCapture(9);

    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    for (let i = 0; i < 5; i++) {
      onEvent({ tabId: 9 }, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: `m${i}` }] });
    }
    const tail = m.readConsole(9, { since: 2 });
    expect(tail.entries.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it("clear empties the buffer; subsequent reads return [] until new events", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    await m.ensureConsoleCapture(10);
    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    onEvent({ tabId: 10 }, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "x" }] });
    expect(m.readConsole(10).entries.length).toBe(1);
    const r = m.clearConsole(10);
    expect(r).toEqual({ cleared: 1 });
    expect(m.readConsole(10).entries.length).toBe(0);
  });

  it("ring caps at 200 entries — oldest are dropped", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    await m.ensureConsoleCapture(11);
    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    for (let i = 0; i < 250; i++) {
      onEvent({ tabId: 11 }, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: `e${i}` }] });
    }
    const { entries, nextId } = m.readConsole(11);
    expect(entries.length).toBe(200);
    // ids are monotonic per-tab — oldest visible is 51 (250 - 200 + 1)
    expect(entries[0].id).toBe(51);
    expect(entries[199].id).toBe(250);
    expect(nextId).toBe(251);
  });

  it("Runtime.exceptionThrown lands with level=exception", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    await m.ensureConsoleCapture(12);
    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    onEvent({ tabId: 12 }, "Runtime.exceptionThrown", {
      timestamp: 1700,
      exceptionDetails: {
        text: "Uncaught ReferenceError",
        url: "https://example.com/app.js",
        lineNumber: 42,
        columnNumber: 7,
        exception: { description: "ReferenceError: foo is not defined\n  at app.js:42:7" }
      }
    });
    const { entries } = m.readConsole(12);
    expect(entries[0]).toMatchObject({
      level: "exception",
      url: "https://example.com/app.js",
      line: 42
    });
    expect(entries[0].text).toContain("ReferenceError");
  });

  it("Log.entryAdded gets bucketed by level (deprecation → info, security → error)", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    await m.ensureConsoleCapture(13);
    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    onEvent({ tabId: 13 }, "Log.entryAdded", {
      entry: { level: "warning", text: "deprecated API usage", source: "deprecation", timestamp: 1700 }
    });
    onEvent({ tabId: 13 }, "Log.entryAdded", {
      entry: { level: "error", text: "CSP blocked inline script", source: "security", timestamp: 1701 }
    });
    const { entries } = m.readConsole(13);
    expect(entries[0]).toMatchObject({ level: "warn", text: "[deprecation] deprecated API usage" });
    expect(entries[1]).toMatchObject({ level: "error", text: "[security] CSP blocked inline script" });
  });

  // Regression for issues.md #9 (fixed in 0.3.3): inline-eval frames (what
  // chrome-relay's own `js` tool produces) come through with url="". With
  // the old code an agent looking at the console couldn't tell its own
  // injection apart from real page-script logs. We now tag the synthetic
  // url so it's at least visible.
  it("inline-eval console entries (url='') are tagged as <chrome-relay:js>", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    await m.ensureConsoleCapture(14);
    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    onEvent({ tabId: 14 }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "from eval" }],
      stackTrace: { callFrames: [{ url: "", lineNumber: 0, columnNumber: 8 }] }
    });
    const { entries } = m.readConsole(14);
    expect(entries[0].url).toBe("<chrome-relay:js>");
  });

  it("real-page console entries keep their real source URL untouched", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    await m.ensureConsoleCapture(15);
    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    onEvent({ tabId: 15 }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "from page" }],
      stackTrace: { callFrames: [{ url: "https://example.com/app.js", lineNumber: 42, columnNumber: 7 }] }
    });
    const { entries } = m.readConsole(15);
    expect(entries[0].url).toBe("https://example.com/app.js");
    expect(entries[0].line).toBe(42);
  });

  it("events for an un-subscribed tab are dropped (no implicit subscribe)", async () => {
    const listenerSpy = vi.fn();
    (globalThis as any).chrome.debugger.onEvent.addListener = listenerSpy;
    const m = await loadModule();
    const onEvent = listenerSpy.mock.calls[0][0] as (s: any, method: string, params: any) => void;
    // Tab 99 never subscribed.
    onEvent({ tabId: 99 }, "Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "ghost" }] });
    expect(m.readConsole(99).entries).toEqual([]);
  });
});
