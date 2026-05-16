import { test, expect } from "../helpers/extension-context";

test.describe("fill — <select>", () => {
  test("changes select value and fires change event", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("native-select.html");

    const result = await runTool<{ filled: boolean; kind: string }>("chrome_fill_or_select", {
      tabId,
      selector: "#country",
      value: "in"
    });
    expect(result.kind).toBe("select");

    const diag = await runTool<{ result: { value: string; changeCount: number } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__diag()" }
    );
    expect(diag.result.value).toBe("in");
    expect(diag.result.changeCount).toBe(1);
  });

  test("non-existent option clears the select value (browser default)", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("native-select.html");
    await runTool("chrome_fill_or_select", { tabId, selector: "#country", value: "zz" });
    const diag = await runTool<{ result: { value: string } }>(
      "chrome_evaluate",
      { tabId, code: "return window.__diag()" }
    );
    // HTMLSelectElement.value returns "" when no option matches the assignment.
    // Documenting actual behavior — agents should call read -i first to see valid values.
    expect(diag.result.value).toBe("");
  });
});
