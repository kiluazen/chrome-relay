import { test, expect } from "../helpers/extension-context";

test.describe("keys — CDP Input.dispatchKeyEvent for special keys + chords", () => {
  test("Enter dispatches with key='Enter', code='Enter', isTrusted=true", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("keyboard-special.html");

    await runTool("chrome_keyboard", { tabId, keys: "Enter" });

    const last = await runTool<{ result: { key: string; code: string; isTrusted: boolean } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__last()" }
    );
    expect(last.result.key).toBe("Enter");
    expect(last.result.code).toBe("Enter");
    expect(last.result.isTrusted).toBe(true);
  });

  test("Tab key", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("keyboard-special.html");
    await runTool("chrome_keyboard", { tabId, keys: "Tab" });
    const last = await runTool<{ result: { key: string; code: string } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__last()" }
    );
    expect(last.result.key).toBe("Tab");
    expect(last.result.code).toBe("Tab");
  });

  test("Escape key", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("keyboard-special.html");
    await runTool("chrome_keyboard", { tabId, keys: "Escape" });
    const last = await runTool<{ result: { key: string } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__last()" }
    );
    expect(last.result.key).toBe("Escape");
  });

  test("ArrowDown key", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("keyboard-special.html");
    await runTool("chrome_keyboard", { tabId, keys: "ArrowDown" });
    const last = await runTool<{ result: { key: string; code: string } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__last()" }
    );
    expect(last.result.key).toBe("ArrowDown");
    expect(last.result.code).toBe("ArrowDown");
  });

  test("Cmd+K records meta modifier", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("keyboard-special.html");
    await runTool("chrome_keyboard", { tabId, keys: "Cmd+K" });
    const last = await runTool<{ result: { key: string; modifiers: { meta: boolean; shift: boolean } } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__last()" }
    );
    expect(last.result.key).toBe("K");
    expect(last.result.modifiers.meta).toBe(true);
    expect(last.result.modifiers.shift).toBe(false);
  });

  test("Shift+ArrowDown records shift modifier", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("keyboard-special.html");
    await runTool("chrome_keyboard", { tabId, keys: "Shift+ArrowDown" });
    const last = await runTool<{ result: { key: string; modifiers: { shift: boolean; meta: boolean } } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__last()" }
    );
    expect(last.result.key).toBe("ArrowDown");
    expect(last.result.modifiers.shift).toBe(true);
    expect(last.result.modifiers.meta).toBe(false);
  });

  test("error: multi-char non-special keys point users to chrome_type", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("keyboard-special.html");
    await expect(
      runTool("chrome_keyboard", { tabId, keys: "hello" })
    ).rejects.toThrow(/Unknown key|chrome_type|named key|chord/);
  });
});
