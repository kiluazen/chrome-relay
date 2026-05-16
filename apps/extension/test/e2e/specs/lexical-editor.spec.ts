import { test, expect } from "../helpers/extension-context";

test.describe("type — contenteditable / Lexical-style editor", () => {
  test("Input.insertText fires trusted beforeinput + input events", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("lexical-editor.html");

    const result = await runTool<{ typed: boolean; length: number }>("chrome_type", {
      tabId,
      selector: '[data-testid="editor"]',
      text: "hello world"
    });
    expect(result.typed).toBe(true);
    expect(result.length).toBe(11);

    const diag = await runTool<{ result: { text: string; eventCount: number; trustedBeforeInputs: number } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__diag()" }
    );

    expect(diag.result.text).toContain("hello world");
    expect(diag.result.trustedBeforeInputs).toBeGreaterThan(0);
  });

  test("--selector auto-focuses before insertText", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("lexical-editor.html");
    await runTool("chrome_type", {
      tabId,
      selector: '[data-testid="editor"]',
      text: "auto-focused"
    });

    const focused = await runTool<{ result: string }>("chrome_evaluate", {
      tabId,
      code: 'return document.activeElement?.getAttribute("data-testid") ?? null'
    });
    expect(focused.result).toBe("editor");
  });

  test("focusSelector throws on missing element", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("lexical-editor.html");
    await expect(
      runTool("chrome_type", {
        tabId,
        selector: "#does-not-exist",
        text: "x"
      })
    ).rejects.toThrow(/Element not found/);
  });
});
