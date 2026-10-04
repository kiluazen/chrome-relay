import { test, expect } from "../helpers/extension-context";

// The cursor-interactive sweep reads element handles over CDP; it must not
// write marker attributes into the page (apps with MutationObservers would
// react to them).

test("snapshot sweep finds div-soup clickables without mutating the page", async ({ runTool, openFixture }) => {
  const { tabId } = await openFixture("sweep-no-mutation.html");
  const before = await runTool<{ result: number }>("chrome_evaluate", { tabId, code: "return window.__mutations" });
  const snap = await runTool<{ refs: Record<string, { role: string; name: string }> }>("chrome_snapshot", {
    tabId,
    interactiveOnly: true
  });
  const clickables = Object.values(snap.refs).filter((r) => r.role === "clickable").map((r) => r.name);
  expect(clickables).toEqual(["Open card A", "Open card B"]);
  const mutations = await runTool<{ result: number }>("chrome_evaluate", { tabId, code: "return window.__mutations" });
  expect(mutations.result).toBe(before.result);
});
