import { test, expect } from "../helpers/extension-context";

// The agent cursor: an arrow drawn where the agent acts. It must be drawn,
// stay out of the page's way (scripts, snapshots, hit tests, observers),
// never block the action, stay out of `screenshot`, and switch off.

interface SnapshotResult {
  refs: Record<string, { role: string; name: string }>;
  nodes: unknown[];
}

const pixelAt = (serviceWorker: import("@playwright/test").Worker, dataUrl: string, x: number, y: number) =>
  serviceWorker.evaluate(
    async ({ dataUrl, x, y }) => {
      const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const g = canvas.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      return Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
    },
    { dataUrl, x, y }
  );

test.describe("agent cursor", () => {
  test.afterEach(async ({ runTool }) => {
    await runTool("chrome_cursor", { enabled: true });
  });

  test("glides to the click point; its API and shadow tree are hidden and the click still lands", async ({ runTool, openFixture, serviceWorker }) => {
    const { tabId } = await openFixture("cursor.html");
    const snap = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true });
    const go = Object.entries(snap.refs).find(([, r]) => r.name === "Go")?.[0];
    const click = await runTool<{ x: number; y: number }>("chrome_click_element", { ref: go, waitForNavigation: false });

    const page = await runTool<{ result: { clicks: number; mutations: number; hostCount: number; shadow: unknown; api: string } }>(
      "chrome_evaluate",
      {
        tabId,
        code: `const h = document.querySelector("chrome-relay-cursor");
          return { clicks: window.__clicks, mutations: window.__mutations,
                   hostCount: document.querySelectorAll("chrome-relay-cursor").length,
                   shadow: h && h.shadowRoot, api: typeof window.__crCursor };`
      }
    );
    expect(page.result.clicks).toBe(1);
    expect(page.result.hostCount).toBe(1);
    expect(page.result.shadow).toBeNull(); // closed shadow root
    expect(page.result.api).toBe("undefined"); // lives in an isolated world
    const mutationsAfterFirst = page.result.mutations;

    // Let the glide land, then capture raw (cursor visible): the arrow's
    // dark body sits just below-right of the click point.
    await new Promise((r) => setTimeout(r, 700));
    const raw = await serviceWorker.evaluate(async (tabId: number) => {
      const r = (await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "png" })) as { data: string };
      return `data:image/png;base64,${r.data}`;
    }, tabId);
    const arrowPixel = await pixelAt(serviceWorker, raw, click.x + 4, click.y + 12);
    expect(arrowPixel.reduce((a, b) => a + b, 0)).toBeLessThan(300); // dark arrow fill, not white page

    // The screenshot tool hides it.
    const shot = await runTool<{ dataUrl: string }>("chrome_screenshot", { tabId });
    expect(await pixelAt(serviceWorker, shot.dataUrl, click.x + 4, click.y + 12)).toEqual([255, 255, 255]);

    // A second move happens entirely inside the closed shadow root: the
    // page's observer sees nothing new, and snapshots never include it.
    await runTool("chrome_click_element", { ref: go, waitForNavigation: false });
    const after = await runTool<{ result: number }>("chrome_evaluate", { tabId, code: "return window.__mutations" });
    expect(after.result).toBe(mutationsAfterFirst);
    const snap2 = await runTool<SnapshotResult>("chrome_snapshot", { tabId });
    expect(JSON.stringify(snap2.nodes)).not.toContain("typing");
  });

  test("cursor off: nothing is drawn", async ({ runTool, openFixture }) => {
    expect(await runTool("chrome_cursor", {})).toEqual({ enabled: true });
    expect(await runTool("chrome_cursor", { enabled: false })).toEqual({ enabled: false });
    const { tabId } = await openFixture("cursor.html");
    await runTool("chrome_click_element", { tabId, selector: "#go", waitForNavigation: false });
    const hosts = await runTool<{ result: number }>("chrome_evaluate", {
      tabId,
      code: `return document.querySelectorAll("chrome-relay-cursor").length`
    });
    expect(hosts.result).toBe(0);
  });
});
