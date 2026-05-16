import { test, expect } from "../helpers/extension-context";

test.describe("fill — React-controlled input (native setter bypass)", () => {
  test("fills a controlled input through the native prototype setter", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("react-controlled-input.html");

    await runTool("chrome_fill_or_select", {
      tabId,
      selector: "#target",
      value: "kushal"
    });

    const diag = await runTool<{ result: { committed: string; directAssigns: number; domValue: string } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__diag()" }
    );

    expect(diag.result.committed).toBe("kushal");
    expect(diag.result.domValue).toBe("kushal");
    // Native setter path used — no direct prop assignments observed by the swallow.
    expect(diag.result.directAssigns).toBe(0);
  });
});
