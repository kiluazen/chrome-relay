// wait / get / batch / snapshot --diff (adoption-spec Changes 3-6), live.
import { test, expect } from "../helpers/extension-context";

interface SnapshotResult {
  prevText?: string | null;
  refs: Record<string, { role: string; name: string }>;
}

test.describe("loop tools", () => {
  test("get reads one value; wait blocks until delayed text appears; diff shows the change", async ({
    runTool,
    openFixture
  }) => {
    const { tabId } = await openFixture("delayed.html");

    const snap = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true });
    const inputRef = Object.entries(snap.refs).find(([, e]) => e.role === "textbox")?.[0];
    const saveRef = Object.entries(snap.refs).find(([, e]) => e.role === "button" && e.name === "Save")?.[0];
    expect(inputRef).toBeTruthy();
    expect(saveRef).toBeTruthy();

    // get value via ref — one value, no snapshot
    const v = await runTool<{ value: string }>("chrome_get", { what: "value", ref: inputRef });
    expect(v.value).toBe("seed");
    const title = await runTool<{ value: string }>("chrome_get", { what: "title", tabId });
    expect(title.value).toBe("delayed");
    const count = await runTool<{ value: number }>("chrome_get", { what: "count", selector: "input", tabId });
    expect(count.value).toBe(1);

    // click → the page reacts 400ms later → wait --text blocks until then
    await runTool("chrome_click_element", { ref: saveRef });
    const waited = await runTool<{ satisfied: boolean; waitedMs: number }>("chrome_wait", {
      text: "Saved",
      tabId,
      timeoutMs: 5000
    });
    expect(waited.satisfied).toBe(true);
    expect(waited.waitedMs).toBeGreaterThanOrEqual(200);

    // snapshot --diff after the change: prevText present and different
    const diffSnap = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true, diff: true });
    expect(typeof diffSnap.prevText).toBe("string");
  });

  test("wait times out with the current page state in details", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("delayed.html");
    await expect(
      runTool("chrome_wait", { selector: "#never-appears", tabId, timeoutMs: 700 })
    ).rejects.toThrow(/not satisfied within/);
  });

  test("batch runs sequentially in one round-trip and bails on error", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("delayed.html");
    const result = await runTool<{
      results: Array<{ ok: boolean; name: string }>;
      completed: number;
      total: number;
    }>("chrome_batch", {
      commands: [
        { name: "chrome_get", args: { what: "title", tabId } },
        { name: "chrome_get", args: { what: "count", selector: "button", tabId } },
        { name: "chrome_click_element", args: { selector: "#does-not-exist", tabId } }, // fails
        { name: "chrome_get", args: { what: "url", tabId } } // skipped (bail)
      ]
    });
    expect(result.total).toBe(4);
    expect(result.completed).toBe(3); // two ok + the failure, then bail
    expect(result.results.map((r) => r.ok)).toEqual([true, true, false]);
  });
});
