import { test, expect } from "../helpers/extension-context";

// Adoption-spec Change 2, step 3: a ref click hit-tests its point and
// refuses to click through an unrelated element (overlay, sticky header,
// modal) instead of reporting success while the overlay ate the click.

interface SnapshotResult {
  refs: Record<string, { role: string; name: string; backendNodeId: number }>;
}

test.describe("ref clicks — interception hit-test", () => {
  test("click @ref under an overlay fails with click_intercepted; succeeds once the overlay is gone", async ({
    runTool,
    openFixture
  }) => {
    const { tabId } = await openFixture("overlay.html");

    const snap = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true });
    const buttonRef = Object.entries(snap.refs).find(
      ([, e]) => e.role === "button" && e.name === "Click me"
    )?.[0];
    expect(buttonRef).toBeTruthy();

    // Covered: the overlay owns the click point — structured refusal, and
    // the page must NOT have received the click.
    await expect(runTool("chrome_click_element", { ref: buttonRef })).rejects.toThrow(
      /owns the click point/
    );
    const before = await runTool<{ result: string }>("chrome_evaluate", {
      tabId,
      code: "return document.getElementById('result').textContent"
    });
    expect(before.result).toBe("");

    // Remove the overlay — same ref (same-page DOM churn keeps refs valid).
    await runTool("chrome_evaluate", {
      tabId,
      code: "document.getElementById('overlay').remove(); return true"
    });
    await runTool("chrome_click_element", { ref: buttonRef });
    const after = await runTool<{ result: string }>("chrome_evaluate", {
      tabId,
      code: "return document.getElementById('result').textContent"
    });
    expect(after.result).toBe("clicked");
  });
});
