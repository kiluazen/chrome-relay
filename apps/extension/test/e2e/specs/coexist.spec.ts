import { test, expect } from "../helpers/extension-context";
import type { Page, Worker } from "@playwright/test";

// The person and the agent share one Chrome. The agent borrows tabs and
// gives them back (idle detach, release), waits while the person types in a
// tab, and keeps the tabs it opens in an "Agent" group.

async function openPage(
  extensionContext: import("@playwright/test").BrowserContext,
  serviceWorker: Worker,
  url: string
): Promise<{ page: Page; tabId: number }> {
  const page = await extensionContext.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const tabId = (await serviceWorker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null, url)) as number | null;
  if (tabId === null) throw new Error(`No tab id for ${url}`);
  return { page, tabId };
}

// Whether the extension still has a debugger session on the tab. (Not
// getTargets().attached: Playwright's own CDP connection counts there.)
const debuggerAttached = (serviceWorker: Worker, tabId: number) =>
  serviceWorker.evaluate(async (id) => {
    try {
      await chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", { expression: "1" });
      return true;
    } catch {
      return false;
    }
  }, tabId);

const hasFocusIsNative = (page: Page) =>
  page.evaluate(() => Document.prototype.hasFocus.toString().includes("[native code]"));

test.describe("person and agent share the browser", () => {
  test.afterEach(async ({ serviceWorker, runTool }) => {
    await serviceWorker.evaluate(() =>
      (globalThis as { __chromeRelay?: { setIdleDetachMs?: (ms: number) => void } }).__chromeRelay?.setIdleDetachMs?.(30_000)
    );
    await runTool("chrome_release", { all: true });
  });

  test("an idle tab is given back: debugger detached, page overrides undone", async ({ extensionContext, serviceWorker, fixtures, runTool }) => {
    await serviceWorker.evaluate(() =>
      (globalThis as { __chromeRelay?: { setIdleDetachMs?: (ms: number) => void } }).__chromeRelay?.setIdleDetachMs?.(500)
    );
    const { page, tabId } = await openPage(extensionContext, serviceWorker, fixtures.url("/coexist.html"));
    await runTool("chrome_evaluate", { tabId, code: "return 1" });
    expect(await debuggerAttached(serviceWorker, tabId)).toBe(true);
    expect(await hasFocusIsNative(page)).toBe(false); // visibility/focus shim on

    await expect.poll(() => debuggerAttached(serviceWorker, tabId), { timeout: 5_000 }).toBe(false);
    expect(await hasFocusIsNative(page)).toBe(true);
    const status = await runTool<{ tabs: Array<{ tabId: number }> }>("chrome_status", {});
    expect(status.tabs.find((t) => t.tabId === tabId)).toBeUndefined();

    // Borrowing it again just works.
    const again = await runTool<{ result: number }>("chrome_evaluate", { tabId, code: "return 2" });
    expect(again.result).toBe(2);
    await page.close();
  });

  test("status shows held tabs; release lets go of them", async ({ extensionContext, serviceWorker, fixtures, runTool }) => {
    const { page, tabId } = await openPage(extensionContext, serviceWorker, fixtures.url("/coexist.html"));
    await runTool("chrome_click_element", { tabId, selector: "#go", waitForNavigation: false });

    const status = await runTool<{ tabs: Array<{ tabId: number; state: string; holding: string[]; lastCommand?: string }> }>("chrome_status", {});
    const held = status.tabs.find((t) => t.tabId === tabId);
    expect(held).toMatchObject({ state: "active", holding: [] });
    expect(held?.lastCommand).toBeTruthy();

    const released = await runTool<{ released: number[] }>("chrome_release", { tabId });
    expect(released.released).toEqual([tabId]);
    expect(await debuggerAttached(serviceWorker, tabId)).toBe(false);
    expect(await hasFocusIsNative(page)).toBe(true);
    await page.close();
  });

  test("agent input waits while the person is typing in that tab", async ({ extensionContext, serviceWorker, fixtures, runTool }) => {
    const { page, tabId } = await openPage(extensionContext, serviceWorker, fixtures.url("/coexist.html"));
    await page.locator("#field").click();
    await page.keyboard.type("hello", { delay: 40 });

    const started = Date.now();
    await runTool("chrome_click_element", { tabId, selector: "#go", waitForNavigation: false });
    const waited = Date.now() - started;

    expect(waited).toBeGreaterThan(900); // held until the person paused (1.5s quiet)
    expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
    expect(await page.locator("#field").inputValue()).toBe("hello");
    await page.close();
  });

  test("agent input to a tab the person isn't using goes straight through", async ({ extensionContext, serviceWorker, fixtures, runTool }) => {
    const mine = await openPage(extensionContext, serviceWorker, fixtures.url("/coexist.html?mine"));
    const agents = await openPage(extensionContext, serviceWorker, fixtures.url("/coexist.html?agent"));
    await mine.page.locator("#field").click();
    await mine.page.keyboard.type("hello", { delay: 40 });

    const started = Date.now();
    await runTool("chrome_click_element", { tabId: agents.tabId, selector: "#go", waitForNavigation: false });
    expect(Date.now() - started).toBeLessThan(900);
    await mine.page.close();
    await agents.page.close();
  });

  test("tabs the agent opens join an Agent group", async ({ serviceWorker, fixtures, runTool }) => {
    const a = await runTool<{ tabId: number }>("chrome_navigate", { url: fixtures.url("/coexist.html?a"), newTab: true });
    const b = await runTool<{ tabId: number }>("chrome_navigate", { url: fixtures.url("/coexist.html?b"), newTab: true });
    const groups = await serviceWorker.evaluate(async (ids) => {
      const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      const titles = await Promise.all(tabs.map(async (t) => (t.groupId >= 0 ? (await chrome.tabGroups.get(t.groupId)).title : null)));
      return { groupIds: tabs.map((t) => t.groupId), titles };
    }, [a.tabId, b.tabId]);
    expect(groups.titles).toEqual(["Agent", "Agent"]);
    expect(groups.groupIds[0]).toBe(groups.groupIds[1]);
    await serviceWorker.evaluate(async (ids) => chrome.tabs.remove(ids), [a.tabId, b.tabId]);
  });
});
