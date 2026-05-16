import { test, expect } from "../helpers/extension-context";

test.describe("js — shadow DOM piercing", () => {
  test("read -i cannot see shadow children", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("shadow-dom.html");

    const snap = await runTool<{ elements: Array<{ tagName: string; selector: string }> }>(
      "chrome_read_page",
      { tabId, interactiveOnly: true }
    );

    // Shadow children invisible to querySelectorAll('*') from light DOM.
    expect(snap.elements.find((e) => e.selector === "#inner")).toBeUndefined();
  });

  test("js can pierce the shadow root and read inner input", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("shadow-dom.html");

    const result = await runTool<{ result: string | null }>("chrome_evaluate", {
      tabId,
      code: "return document.getElementById('ftin').shadowRoot.querySelector('input').tagName"
    });
    expect(result.result).toBe("INPUT");
  });

  test("js can write into the shadow input via native setter trick", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("shadow-dom.html");

    await runTool("chrome_evaluate", {
      tabId,
      code: `
        const input = document.getElementById('ftin').shadowRoot.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'shadow-write');
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        return true;
      `
    });

    const committed = await runTool<{ result: string }>("chrome_evaluate", {
      tabId,
      code: "return document.getElementById('committed').textContent"
    });
    expect(committed.result).toBe("shadow-write");
  });
});
