import { test, expect } from "../helpers/extension-context";

test.describe("screenshot — backgrounded tab", () => {
  test("captures a non-active tab without activating it", async ({ extensionContext, serviceWorker, fixtures, runTool, openFixture }) => {
    const { tabId: bgTabId } = await openFixture("screenshot-bg.html");

    // Open a second tab to push the fixture into background.
    const foreground = await extensionContext.newPage();
    await foreground.goto(fixtures.url("/keyboard-special.html"));

    // Capture the backgrounded tab.
    const result = await runTool<{ tabId: number; dataUrl: string }>("chrome_screenshot", {
      tabId: bgTabId
    });

    expect(result.tabId).toBe(bgTabId);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    expect(result.dataUrl.length).toBeGreaterThan(1000);

    // Confirm the foreground tab is still focused — bgTab was never activated.
    const activeTabs = await serviceWorker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
    expect(activeTabs[0].url).toContain("keyboard-special.html");
  });

  test("--full / fullPage captures beyond the viewport", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("screenshot-bg.html");

    const viewport = await runTool<{ dataUrl: string }>("chrome_screenshot", { tabId });
    const full = await runTool<{ dataUrl: string }>("chrome_screenshot", { tabId, fullPage: true });

    // Full-page PNG should be larger than the viewport-only PNG (taller screenshot).
    expect(full.dataUrl.length).toBeGreaterThan(viewport.dataUrl.length);
  });
});
