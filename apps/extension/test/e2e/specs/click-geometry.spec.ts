import { test, expect } from "../helpers/extension-context";

// Ref clicks locate and hit-test inside the page. Two failures this guards:
//   - a link below the fold (HN's "More"): after scrolling it into view,
//     DOM.getNodeForLocation hit-tested the point as if the page had not
//     scrolled, so the click was refused as intercepted by a story link.
//     Reproduced on live HN (agent-loop-bench --real); this fixture guards
//     the path but has not reproduced the misfire itself;
//   - an element just under a sticky header: centered once, then clicked.

interface SnapshotResult {
  refs: Record<string, { role: string; name: string }>;
}

// Match role too: a table cell named by its content also gets a ref.
const refNamed = (snap: SnapshotResult, role: string, name: string) =>
  Object.entries(snap.refs).find(([, e]) => e.role === role && e.name === name)?.[0];

test.describe("ref click geometry", () => {
  test("link below the fold: scrolls it into view and clicks it, no false interception", async ({ runTool, fixtures }) => {
    // A background tab that has never been shown — Chrome Relay's normal case.
    const { tabId } = await runTool<{ tabId: number }>("chrome_navigate", {
      url: fixtures.url("below-fold.html"),
      newTab: true,
      waitUntil: "load"
    });
    // elide:false — 60 identical story links would otherwise elide "More".
    const snap = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true, elide: false });
    const more = refNamed(snap, "link", "More");
    expect(more).toBeTruthy();
    await runTool("chrome_click_element", { ref: more, waitForNavigation: false });
    const diag = await runTool<{ result: { log: string[]; scrollY: number } }>("chrome_evaluate", {
      tabId,
      code: "return window.__diag()"
    });
    expect(diag.result.log).toEqual(["more"]);
    expect(diag.result.scrollY).toBeGreaterThan(0);
    await runTool("chrome_close_tabs", { tabIds: [tabId] });
  });

  test("element under a sticky header is re-centered, then clicked", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("click-geometry.html");
    const snap = await runTool<SnapshotResult>("chrome_snapshot", { tabId, interactiveOnly: true });
    const top = refNamed(snap, "button", "Top target");
    expect(top).toBeTruthy();
    // Park the button underneath the 80px sticky header.
    await runTool("chrome_evaluate", {
      tabId,
      code: "const b = document.getElementById('top-target'); window.scrollTo(0, b.offsetTop - 20); return window.scrollY"
    });
    await runTool("chrome_click_element", { ref: top, waitForNavigation: false });
    const diag = await runTool<{ result: { log: string[] } }>("chrome_evaluate", { tabId, code: "return window.__diag()" });
    expect(diag.result.log).toEqual(["top"]);
  });
});
