import { test, expect } from "../helpers/extension-context";

// `click --snapshot`: the click arms a reaction tracker (settle:true), and
// the following snapshot({ settle: true }) waits for the page to stop
// reacting, so the agent sees the result instead of the frame before it.

interface SnapshotResult {
  refs: Record<string, { role: string; name: string }>;
}
const names = (snap: SnapshotResult) => Object.values(snap.refs).map((r) => r.name);
const refNamed = (snap: SnapshotResult, name: string) => Object.entries(snap.refs).find(([, r]) => r.name === name)?.[0];

test.describe("snapshot settle", () => {
  test("waits out a reaction scheduled on the next timer", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("settle.html");
    const first = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true });
    await runTool("chrome_click_element", { ref: refNamed(first, "Load more"), waitForNavigation: false, settle: true });
    const settled = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true, settle: true });
    expect(names(settled)).toContain("Loaded result");
  });

  test("waits for a request the click started, past the spinner", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("settle.html");
    const first = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true });
    await runTool("chrome_click_element", { ref: refNamed(first, "Fetch"), waitForNavigation: false, settle: true });
    const settled = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true, settle: true });
    expect(names(settled)).toContain("Fetched result");
  });

  test("returns promptly on a quiet page, and leaves nothing on the page's window", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("settle.html");
    const started = Date.now();
    await runTool("chrome_snapshot", { tabId, interactiveOnly: true, settle: true });
    expect(Date.now() - started).toBeLessThan(800);
    const leaked = await runTool<{ result: string }>("chrome_evaluate", { tabId, code: "return window.__isolated()" });
    expect(leaked.result).toBe("undefined"); // the counter lives in an isolated world
  });
});
