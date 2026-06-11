import { test, expect } from "../helpers/extension-context";

test.describe("shadow DOM piercing", () => {
  test("snapshot sees the shadow input and fill @ref writes through the boundary", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("shadow-dom.html");

    // The old readPageSnapshot (querySelectorAll from light DOM) could NOT
    // see shadow children — that limitation was a pinned test here. The
    // unified snapshot reads the AX tree, which pierces shadow roots, so
    // the inner <input> gets a ref like any other textbox.
    const snap = await runTool<{
      refs: Record<string, { role: string; backendNodeId: number; tabId: number }>;
    }>("chrome_snapshot", { tabId, interactiveOnly: true });

    const textboxRef = Object.entries(snap.refs).find(([, e]) => e.role === "textbox")?.[0];
    expect(textboxRef).toBeTruthy();

    // fill-by-ref resolves through backendNodeId — no CSS, no boundary issue.
    const filled = await runTool<{ filled: boolean }>("chrome_fill_or_select", {
      ref: textboxRef,
      value: "via-ref"
    });
    expect(filled.filled).toBe(true);

    const committed = await runTool<{ result: string }>("chrome_evaluate", {
      tabId,
      code: "return document.getElementById('committed').textContent"
    });
    expect(committed.result).toBe("via-ref");
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
