import { test, expect } from "../helpers/extension-context";

test.describe("click — dynamically appearing element", () => {
  test("click fails fast on a not-yet-existing selector", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("dynamic-element.html");

    // The button only appears after 300ms. Immediate click should error.
    await expect(
      runTool("chrome_click_element", { tabId, selector: "#ready" })
    ).rejects.toThrow(/Element not found/);
  });

  test("click succeeds after the element appears", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("dynamic-element.html");

    // Caller-side wait — there is intentionally no built-in wait primitive.
    await new Promise((r) => setTimeout(r, 500));

    await runTool("chrome_click_element", { tabId, selector: "#ready" });

    const diag = await runTool<{ result: { clicked: boolean } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__diag()" }
    );
    expect(diag.result.clicked).toBe(true);
  });
});
