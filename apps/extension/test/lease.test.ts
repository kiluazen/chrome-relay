import { describe, it, expect, afterEach, vi } from "vitest";
import { getChromeStub } from "./setup-chrome-mock";
import {
  IDLE_DETACH_MS,
  isAttached,
  listLeases,
  pinTab,
  releaseAll,
  releaseTab,
  send,
  unpinTab
} from "../src/browser/cdp";
import { pressKey } from "../src/browser/keyboard";
import { onAfterDetach } from "../src/browser/lease-hooks";
import {
  HUMAN_MAX_WAIT_MS,
  _resetHumanForTests,
  noteHumanInput,
  yieldToHuman
} from "../src/browser/human";

// cdp.ts keeps its lease table across tests: every test uses its own tab ids.

function commands(tabId: number): Array<[string, Record<string, unknown>]> {
  return getChromeStub()
    .debugger.sendCommand.mock.calls.filter(([target]) => target.tabId === tabId)
    .map(([, method, params]) => [method, params]);
}

afterEach(() => {
  vi.useRealTimers();
  _resetHumanForTests();
});

describe("tab leases", () => {
  it("detaches a tab once it has been idle for IDLE_DETACH_MS", async () => {
    vi.useFakeTimers();
    const stub = getChromeStub();
    await send(2001, "Runtime.evaluate", { expression: "1" });
    expect(isAttached(2001)).toBe(true);

    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS - 1);
    expect(stub.debugger.detach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(stub.debugger.detach).toHaveBeenCalledWith({ tabId: 2001 });
    expect(isAttached(2001)).toBe(false);
  });

  it("each command restarts the idle clock", async () => {
    vi.useFakeTimers();
    const stub = getChromeStub();
    await send(2002, "Runtime.evaluate", { expression: "1" });
    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS - 1_000);
    await send(2002, "Runtime.evaluate", { expression: "2" });
    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS - 1_000);
    expect(stub.debugger.detach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.debugger.detach).toHaveBeenCalledWith({ tabId: 2002 });
  });

  it("reverts the in-page visibility shim before detaching", async () => {
    await send(2003, "Runtime.evaluate", { expression: "1" });
    await releaseTab(2003);
    const unpatch = commands(2003).find(
      ([m, p]) => m === "Runtime.evaluate" && String(p.expression).includes("__chrome_relay_visibility_patched__")
    );
    expect(unpatch).toBeDefined();
    expect(getChromeStub().debugger.detach).toHaveBeenCalledWith({ tabId: 2003 });
  });

  it("runs after-detach hooks so modules reset per-session state", async () => {
    const seen: number[] = [];
    onAfterDetach((tabId) => {
      seen.push(tabId);
    });
    await send(2004, "Runtime.evaluate", { expression: "1" });
    await releaseTab(2004);
    expect(seen).toContain(2004);
  });

  it("a pinned tab goes quiet instead of detaching: overrides undone, session kept", async () => {
    vi.useFakeTimers();
    const stub = getChromeStub();
    await send(2005, "Runtime.evaluate", { expression: "1" });
    pinTab(2005, "console");

    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS);
    expect(stub.debugger.detach).not.toHaveBeenCalled();
    expect(isAttached(2005)).toBe(true);
    expect(listLeases().find((l) => l.tabId === 2005)?.state).toBe("quiet");
    expect(commands(2005)).toContainEqual(["Emulation.setFocusEmulationEnabled", { enabled: false }]);

    // The next command wakes it.
    await send(2005, "Runtime.evaluate", { expression: "2" });
    expect(listLeases().find((l) => l.tabId === 2005)?.state).toBe("active");

    // Unpinned, it detaches on the next idle.
    unpinTab(2005, "console");
    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS);
    expect(stub.debugger.detach).toHaveBeenCalledWith({ tabId: 2005 });
  });

  it("release ignores pins", async () => {
    await send(2006, "Runtime.evaluate", { expression: "1" });
    pinTab(2006, "network");
    expect(await releaseTab(2006)).toBe(true);
    expect(isAttached(2006)).toBe(false);
  });

  it("releaseAll detaches every held tab and reports them", async () => {
    await send(2007, "Runtime.evaluate", { expression: "1" });
    await send(2008, "Runtime.evaluate", { expression: "1" });
    const released = await releaseAll();
    expect(released).toEqual(expect.arrayContaining([2007, 2008]));
    expect(isAttached(2007)).toBe(false);
    expect(isAttached(2008)).toBe(false);
  });

  it("releaseTab on a tab we don't hold is a no-op", async () => {
    expect(await releaseTab(2009)).toBe(false);
    expect(getChromeStub().debugger.detach).not.toHaveBeenCalled();
  });
});

describe("held input", () => {
  it("a press with no release is let go of when the tab is released", async () => {
    await send(2101, "Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, button: "left", buttons: 1 });
    expect(listLeases().find((l) => l.tabId === 2101)?.holding).toEqual(["mouse:left"]);
    await releaseTab(2101);
    expect(commands(2101)).toContainEqual([
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mouseReleased", x: 10, y: 20, button: "left", buttons: 0 })
    ]);
  });

  it("a press that throws still counts as held (it may have landed)", async () => {
    const stub = getChromeStub();
    await send(2102, "Runtime.evaluate", { expression: "1" });
    stub.debugger.sendCommand.mockRejectedValueOnce(new Error("Inspected target navigated or closed"));
    await expect(
      send(2102, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2, button: "left", buttons: 1 })
    ).rejects.toThrow();
    expect(listLeases().find((l) => l.tabId === 2102)?.holding).toEqual(["mouse:left"]);
  });

  it("keyUp still goes out when keyDown fails", async () => {
    const stub = getChromeStub();
    await send(2103, "Runtime.evaluate", { expression: "1" });
    stub.debugger.sendCommand.mockRejectedValueOnce(new Error("boom"));
    await expect(pressKey(2103, "Enter")).rejects.toThrow("boom");
    const ups = commands(2103).filter(([m, p]) => m === "Input.dispatchKeyEvent" && p.type === "keyUp");
    expect(ups).toHaveLength(1);
    expect(listLeases().find((l) => l.tabId === 2103)?.holding).toEqual([]);
  });

  it("a held key is released (keyUp) on release", async () => {
    await send(2104, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 });
    await releaseTab(2104);
    expect(commands(2104)).toContainEqual([
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyUp", key: "Meta", code: "MetaLeft" })
    ]);
  });
});

describe("yield to the person", () => {
  it("returns at once when the person hasn't touched the tab", async () => {
    await expect(yieldToHuman(2201)).resolves.toBeUndefined();
  });

  it("waits until the person pauses, then lets agent input through", async () => {
    vi.useFakeTimers();
    noteHumanInput(2202);
    let done = false;
    const p = yieldToHuman(2202).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await p;
    expect(done).toBe(true);
  });

  it("gives up with a retryable user_active error if the person keeps going", async () => {
    vi.useFakeTimers();
    const typing = setInterval(() => noteHumanInput(2203), 200);
    noteHumanInput(2203);
    const p = yieldToHuman(2203).catch((e) => e);
    await vi.advanceTimersByTimeAsync(HUMAN_MAX_WAIT_MS + 200);
    clearInterval(typing);
    const err = await p;
    expect(err).toMatchObject({ code: "user_active", retryable: true });
  });

  it("agent input waits, but a release in flight never does", async () => {
    vi.useFakeTimers();
    const stub = getChromeStub();
    await send(2204, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left", buttons: 1 });
    await vi.advanceTimersByTimeAsync(1_000); // past the agent-echo window
    noteHumanInput(2204);
    const before = stub.debugger.sendCommand.mock.calls.length;
    await send(2204, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left", buttons: 0 });
    expect(stub.debugger.sendCommand.mock.calls.length).toBe(before + 1);
  });

  it("the agent's own input echoing back is not taken for the person", async () => {
    await send(2205, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
    noteHumanInput(2205); // arrives right after the dispatch
    await expect(yieldToHuman(2205)).resolves.toBeUndefined();
  });
});
