import { test, expect } from "../helpers/extension-context";

test.describe("js — Runtime.evaluate in MAIN world", () => {
  test("returns simple values via `return`", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("js-async.html");
    const result = await runTool<{ result: string }>("chrome_evaluate", {
      tabId,
      code: "return document.title"
    });
    expect(result.result).toBe("js-async");
  });

  test("supports top-level await", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("js-async.html");
    const result = await runTool<{ result: { status: string; n: number } }>("chrome_evaluate", {
      tabId,
      code: "return await window.__delayedFetch(20)"
    });
    expect(result.result).toEqual({ status: "ok", n: 7 });
  });

  test("reaches MAIN world globals (framework state)", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("js-async.html");
    const result = await runTool<{ result: { id: number; name: string } }>("chrome_evaluate", {
      tabId,
      code: "return window.__APP_STATE__.user"
    });
    expect(result.result).toEqual({ id: 42, name: "kushal", email: "kushal@example.com" });
  });

  test("returns nested objects JSON-serialized", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("js-async.html");
    const result = await runTool<{ result: unknown[] }>("chrome_evaluate", {
      tabId,
      code: "return window.__APP_STATE__.cart"
    });
    expect(result.result).toEqual([
      { id: "a", price: 10 },
      { id: "b", price: 20 }
    ]);
  });

  test("surfaces page exceptions as errors", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("js-async.html");
    await expect(
      runTool("chrome_evaluate", { tabId, code: "throw new Error('boom from page')" })
    ).rejects.toThrow(/boom from page/);
  });
});
