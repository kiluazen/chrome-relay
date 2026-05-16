import { describe, it, expect, beforeEach, vi } from "vitest";
import { getChromeStub } from "./setup-chrome-mock";
import { ensureAttached, send, evalExpression, evalInTab } from "../src/browser/cdp";

const TAB_ID = 100;

describe("ensureAttached", () => {
  beforeEach(() => {
    // cdp.ts has module-level `attached` Set — we cannot reset it between tests
    // without re-importing. Instead, vary the tab IDs we use per test.
  });

  it("calls chrome.debugger.attach with protocol 1.3", async () => {
    const stub = getChromeStub();
    await ensureAttached(900);
    expect(stub.debugger.attach).toHaveBeenCalledWith({ tabId: 900 }, "1.3");
  });

  it("does not double-attach when called twice on same tab", async () => {
    const stub = getChromeStub();
    await ensureAttached(901);
    await ensureAttached(901);
    expect(stub.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent attach attempts", async () => {
    const stub = getChromeStub();
    let resolveAttach: () => void = () => {};
    stub.debugger.attach.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveAttach = resolve; })
    );

    const a = ensureAttached(902);
    const b = ensureAttached(902);
    resolveAttach();
    await Promise.all([a, b]);

    expect(stub.debugger.attach).toHaveBeenCalledTimes(1);
  });

  it("propagates attach errors that aren't the 'already attached' case", async () => {
    const stub = getChromeStub();
    stub.debugger.attach.mockRejectedValueOnce(new Error("Cannot attach to chrome:// URL"));
    await expect(ensureAttached(903)).rejects.toThrow(/chrome:\/\//);
  });

  it("recovers from a stale 'already attached' by detaching then re-attaching", async () => {
    const stub = getChromeStub();
    stub.debugger.attach.mockRejectedValueOnce(
      new Error("Another debugger is already attached to the tab with id: 904.")
    );
    stub.debugger.detach.mockResolvedValueOnce(undefined);
    stub.debugger.attach.mockResolvedValueOnce(undefined);

    await ensureAttached(904);

    expect(stub.debugger.attach).toHaveBeenCalledTimes(2);
    expect(stub.debugger.detach).toHaveBeenCalledWith({ tabId: 904 });
  });

  it("surfaces a DevTools/other-extension hint when we don't own the session", async () => {
    const stub = getChromeStub();
    stub.debugger.attach.mockRejectedValueOnce(
      new Error("Another debugger is already attached to the tab with id: 905.")
    );
    stub.debugger.detach.mockRejectedValueOnce(
      new Error("Debugger is not attached to the tab with id: 905.")
    );

    await expect(ensureAttached(905)).rejects.toThrow(
      /DevTools|another extension|different tab/
    );
  });
});

describe("send", () => {
  it("attaches before sending", async () => {
    const stub = getChromeStub();
    await send(910, "Page.navigate", { url: "https://example.com" });
    expect(stub.debugger.attach).toHaveBeenCalled();
    expect(stub.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 910 },
      "Page.navigate",
      { url: "https://example.com" }
    );
  });

  it("returns the CDP response value", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({ data: "abc123" });
    const result = await send<{ data: string }>(911, "Page.captureScreenshot", { format: "png" });
    expect(result).toEqual({ data: "abc123" });
  });

  it("forwards method and params verbatim", async () => {
    const stub = getChromeStub();
    await send(912, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 100,
      y: 200,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    const [target, method, params] = stub.debugger.sendCommand.mock.calls[0];
    expect(target).toEqual({ tabId: 912 });
    expect(method).toBe("Input.dispatchMouseEvent");
    expect(params).toEqual({
      type: "mousePressed",
      x: 100,
      y: 200,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
  });
});

describe("evalExpression", () => {
  it("posts Runtime.evaluate with returnByValue + awaitPromise defaults", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({
      result: { type: "string", value: "ok" }
    });

    await evalExpression(920, "1 + 1");

    const params = stub.debugger.sendCommand.mock.calls.at(-1)?.[2];
    expect(params).toMatchObject({
      expression: "1 + 1",
      returnByValue: true,
      awaitPromise: true
    });
  });

  it("merges userGesture + timeout options into the call", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({
      result: { type: "undefined" }
    });

    await evalExpression(921, "doThing()", { userGesture: true, timeout: 30_000 });

    const params = stub.debugger.sendCommand.mock.calls.at(-1)?.[2];
    expect(params).toMatchObject({
      userGesture: true,
      timeout: 30_000,
      returnByValue: true,
      awaitPromise: true
    });
  });

  it("returns the result object verbatim on success", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({
      result: { type: "object", value: { ok: true, n: 42 } }
    });
    const r = await evalExpression(922, "({ok:true,n:42})");
    expect(r).toEqual({ type: "object", value: { ok: true, n: 42 } });
  });

  it("throws with exception.description when present", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({
      result: { type: "undefined" },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "Error: boom\n    at x:1:1" }
      }
    });
    await expect(evalExpression(923, "throw new Error('boom')")).rejects.toThrow(/Error: boom/);
  });

  it("falls back to exceptionDetails.text when exception.description is missing", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({
      result: { type: "undefined" },
      exceptionDetails: { text: "Compilation failed" }
    });
    await expect(evalExpression(924, "{{")).rejects.toThrow(/Compilation failed/);
  });
});

describe("evalInTab", () => {
  it("serializes a function and its args into an apply call", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({
      result: { type: "string", value: "hello kushal" }
    });

    function greet(name: string): string {
      return `hello ${name}`;
    }

    const result = await evalInTab(930, greet, ["kushal"]);

    expect(result).toBe("hello kushal");
    const params = stub.debugger.sendCommand.mock.calls.at(-1)?.[2];
    expect(params.expression).toContain("greet");
    expect(params.expression).toContain("hello");
    expect(params.expression).toContain('["kushal"]');
    expect(params.returnByValue).toBe(true);
  });

  it("passes complex argument structures through JSON", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({
      result: { type: "object", value: { x: 1 } }
    });

    function passthrough(obj: { x: number; nested: { y: string } }) {
      return obj;
    }

    await evalInTab(931, passthrough, [{ x: 1, nested: { y: "z" } }]);
    const expr = stub.debugger.sendCommand.mock.calls.at(-1)?.[2].expression;
    expect(expr).toContain('{"x":1,"nested":{"y":"z"}}');
  });

  it("propagates exceptions from page-side execution", async () => {
    const stub = getChromeStub();
    stub.debugger.sendCommand.mockResolvedValueOnce({
      result: { type: "undefined" },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "Error: nope" }
      }
    });

    function thrower() {
      throw new Error("nope");
    }

    await expect(evalInTab(932, thrower, [])).rejects.toThrow(/nope/);
  });
});
