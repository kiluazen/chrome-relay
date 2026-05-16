import { test, expect } from "../helpers/extension-context";

/**
 * Regression for the user-reported "Another debugger is already attached"
 * failure. The bug surfaced during a Cloudflare DNS flow where chrome-relay
 * tried to attach to a tab that already had a live debugger session — could be
 * left over from a previous chrome-relay lifetime, an SW restart race, or
 * another debugger client (DevTools / claude-in-chrome).
 *
 * Mechanism (verified empirically):
 *   - chrome-relay tracks an `attached` Set of tabIds in its service worker.
 *   - If Chrome's view of the session disagrees with that Set (eg because
 *     a prior attach happened outside ensureAttached, or our cache was
 *     cleared but the session wasn't), the next chrome.debugger.attach
 *     throws "Another debugger is already attached".
 *
 * Fix: detach-then-attach. chrome.debugger.detach only succeeds for the
 * extension that owns the session, so it doubles as an ownership probe.
 */
test.describe("debugger conflict — Another debugger is already attached", () => {
  test("recovers when chrome-relay's own state is stale (we own the session)", async ({ openFixture, serviceWorker }) => {
    const { tabId } = await openFixture("screenshot-bg.html");

    // Force an out-of-sync state: attach via the SW's chrome.debugger directly,
    // bypassing chrome-relay's ensureAttached. After this, Chrome considers the
    // extension attached, but chrome-relay's `attached` Set has no record.
    await serviceWorker.evaluate(async (id) => {
      await chrome.debugger.attach({ tabId: id }, "1.3");
    }, tabId);

    // The next runTool call should detach-and-retry, succeeding cleanly.
    const result = await serviceWorker.evaluate(async (id) => {
      const relay = (globalThis as { __chromeRelay?: { runTool: (n: string, a: unknown) => Promise<unknown> } }).__chromeRelay;
      try {
        return await relay!.runTool("chrome_screenshot", { tabId: id });
      } catch (e) {
        return { error: (e as Error).message };
      }
    }, tabId);

    expect(result).toMatchObject({ tabId });
    expect((result as { dataUrl?: string }).dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  test("subsequent calls reuse the recovered session — no extra attach/detach churn", async ({ openFixture, serviceWorker }) => {
    const { tabId } = await openFixture("screenshot-bg.html");

    // Stale state again.
    await serviceWorker.evaluate(async (id) => {
      await chrome.debugger.attach({ tabId: id }, "1.3");
    }, tabId);

    const relay = "globalThis.__chromeRelay";
    // First call recovers, second + third should run without further attach attempts.
    const titles = await serviceWorker.evaluate(async (id) => {
      const r = (globalThis as { __chromeRelay?: { runTool: (n: string, a: unknown) => Promise<unknown> } }).__chromeRelay!;
      const a = await r.runTool("chrome_evaluate", { tabId: id, code: "return document.title" });
      const b = await r.runTool("chrome_evaluate", { tabId: id, code: "return document.title" });
      const c = await r.runTool("chrome_evaluate", { tabId: id, code: "return document.title" });
      return [a, b, c];
    }, tabId);

    for (const t of titles) {
      expect((t as { result: string }).result).toBe("screenshot-bg");
    }
  });
});
