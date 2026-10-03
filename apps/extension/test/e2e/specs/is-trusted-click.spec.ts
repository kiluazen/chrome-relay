import { test, expect } from "../helpers/extension-context";

test.describe("click — CDP-trusted Input.dispatchMouseEvent", () => {
  test("fast clicks remove the navigation grace period without stealing focus or losing trusted input", async ({
    runTool, openFixture, extensionContext, serviceWorker, fixtures
  }) => {
    const { tabId } = await openFixture("is-trusted-click.html");
    const snapshot = await runTool<{ refs: Record<string, { role: string; name: string }> }>(
      "chrome_snapshot", { tabId }
    );
    const ref = Object.entries(snapshot.refs).find(([, node]) => node.role === "button" && node.name === "click me")?.[0];
    expect(ref).toBeTruthy();
    const foreground = await extensionContext.newPage();
    await foreground.goto(fixtures.url("/keyboard-special.html"));
    const activeBefore = await serviceWorker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
    const normal: number[] = [], fast: number[] = [];
    for (let i = 0; i < 12; i++) {
      const address = i % 3 === 0 ? { tabId, selector: "#btn" }
        : i % 3 === 1 ? { ref } : { tabId, x: 40, y: 90 };
      // Alternate order to avoid a warmup or drift advantage for one mode.
      for (const waitForNavigation of i % 2 === 0 ? [true, false] : [false, true]) {
        const start = performance.now();
        const result = await runTool<{ clicked: boolean; navigationCheck?: string }>("chrome_click_element", { ...address, waitForNavigation });
        (waitForNavigation ? normal : fast).push(performance.now() - start);
        expect(result.clicked).toBe(true);
        expect(result.navigationCheck).toBe(waitForNavigation ? undefined : "immediate");
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ backgroundClickMs: { normalP50: median(normal), fastP50: median(fast), cyclesPerMode: 12 } }));
    const counts = await runTool<{ result: { trusted: number; untrusted: number } }>(
      "chrome_evaluate", { tabId, code: "return window.__diag()" }
    );
    expect(counts.result).toEqual({ trusted: 24, untrusted: 0 });
    const activeAfter = await serviceWorker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
    expect(activeAfter[0].id).toBe(activeBefore[0].id);
    // Relative comparison tolerates machine load while detecting the old 120ms wait.
    expect(median(normal) - median(fast)).toBeGreaterThan(60);
  });

  test("default clicks report delayed navigation; fast clicks can verify it with an explicit wait", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("is-trusted-click.html");
    await runTool("chrome_evaluate", {
      tabId,
      code: "document.getElementById('btn').addEventListener('click', () => setTimeout(() => { location.hash = String(Number(location.hash.slice(1) || 0) + 1); }, 60)); return null"
    });
    const normal = await runTool<{ navigated?: boolean; note?: string }>("chrome_click_element", { tabId, selector: "#btn" });
    expect(normal.navigated).toBe(true);
    expect(normal.note).toContain("re-run snapshot");
    const fast = await runTool<{ clicked: boolean; navigationCheck?: string }>("chrome_click_element", {
      tabId, selector: "#btn", waitForNavigation: false
    });
    expect(fast.clicked).toBe(true);
    expect(fast.navigationCheck).toBe("immediate");
    const waited = await runTool<{ satisfied: boolean }>("chrome_wait", { tabId, urlGlob: "**#2", timeoutMs: 3000 });
    expect(waited.satisfied).toBe(true);
  });

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
