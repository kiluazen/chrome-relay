import { test, expect } from "../helpers/extension-context";

test.describe("click — CDP-trusted Input.dispatchMouseEvent", () => {
  test("CDP click fires with isTrusted=true", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("is-trusted-click.html");

    const result = await runTool<{ clicked: boolean; x: number; y: number }>("chrome_click_element", {
      tabId,
      selector: "#btn"
    });
    expect(result.clicked).toBe(true);

    const diag = await runTool<{ result: { trusted: number; untrusted: number } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__diag()" }
    );
    expect(diag.result.trusted).toBe(1);
    expect(diag.result.untrusted).toBe(0);
  });

  test("synthetic in-page el.click() is NOT trusted (regression fixture)", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("is-trusted-click.html");

    // Verify the page actually distinguishes — sanity check the fixture itself.
    await runTool("chrome_evaluate", {
      tabId,
      code: "document.getElementById('btn').click(); return null"
    });

    const diag = await runTool<{ result: { trusted: number; untrusted: number } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__diag()" }
    );
    expect(diag.result.trusted).toBe(0);
    expect(diag.result.untrusted).toBe(1);
  });
});
