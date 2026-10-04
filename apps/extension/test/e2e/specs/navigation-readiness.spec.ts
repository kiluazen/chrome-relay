import { test, expect } from "../helpers/extension-context";

// A new tab starts on about:blank, whose readyState is already "complete".
// Before readiness checks, navigate → wait --load → snapshot on any page
// slower than that blank document read the blank page. These specs serve
// the document with a delay so the gap is real.

interface SnapshotResult {
  url: string;
  nodeCount: number;
  loading?: boolean;
  refs: Record<string, { role: string; name: string }>;
}

test.describe("navigation readiness", () => {
  test("navigate waitUntil:domcontentloaded returns on the real document, before its slow image", async ({ runTool, fixtures }) => {
    const url = fixtures.url("readiness.html?delay=500");
    const started = Date.now();
    const nav = await runTool<{ tabId: number; url: string; ready: boolean; readyState: string; waitedMs: number }>(
      "chrome_navigate",
      { url, newTab: true, waitUntil: "domcontentloaded" }
    );
    const elapsed = Date.now() - started;
    expect(nav.ready).toBe(true);
    expect(nav.url).toBe(url);
    expect(["interactive", "complete"]).toContain(nav.readyState);
    expect(elapsed).toBeGreaterThanOrEqual(450); // waited for the delayed document
    expect(elapsed).toBeLessThan(1_900); // but not for the 1.5s image

    const snap = await runTool<SnapshotResult>("chrome_snapshot", { tabId: nav.tabId, interactiveOnly: true, waitForReady: false });
    expect(Object.values(snap.refs).some((r) => r.name === "Go")).toBe(true);
    await runTool("chrome_close_tabs", { tabIds: [nav.tabId] });
  });

  test("wait --load is not satisfied by the new tab's about:blank", async ({ runTool, fixtures }) => {
    const url = fixtures.url("readiness.html?delay=500");
    const nav = await runTool<{ tabId: number }>("chrome_navigate", { url, newTab: true });
    await runTool("chrome_wait", { tabId: nav.tabId, load: "domcontentloaded", timeoutMs: 5_000 });
    const href = await runTool<{ result: string }>("chrome_evaluate", { tabId: nav.tabId, code: "return location.href" });
    expect(href.result).toBe(url);
    await runTool("chrome_close_tabs", { tabIds: [nav.tabId] });
  });

  test("snapshot right after a fire-and-forget navigate reads the real page", async ({ runTool, fixtures }) => {
    const url = fixtures.url("readiness.html?delay=500");
    const nav = await runTool<{ tabId: number }>("chrome_navigate", { url, newTab: true });
    const snap = await runTool<SnapshotResult>("chrome_snapshot", { tabId: nav.tabId, interactiveOnly: true });
    expect(snap.url).toBe(url);
    expect(snap.loading).toBeUndefined();
    expect(Object.values(snap.refs).some((r) => r.name === "Go")).toBe(true);
    await runTool("chrome_close_tabs", { tabIds: [nav.tabId] });
  });
});
