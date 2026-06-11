// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock ./cdp.send to return scripted CDP responses. The a11y module reads only
// through send().
let sendMock: ReturnType<typeof vi.fn>;
let chromeTabsGet: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  sendMock = vi.fn();
  chromeTabsGet = vi.fn(async (_id: number) => ({ url: "https://example.com" }));
  (globalThis as any).chrome = { tabs: { get: chromeTabsGet } };
  vi.doMock("../src/browser/cdp", () => ({ send: sendMock }));
});

async function load() {
  return await import("../src/browser/a11y");
}

describe("clickAxNode", () => {
  it("resolves backendDOMNodeId → box → coordinate triple-click", async () => {
    const m = await load();
    const boxModel = { content: [10, 10, 30, 10, 30, 20, 10, 20], width: 20, height: 10 };
    const dispatched: Array<{ type: string; x: number; y: number }> = [];
    sendMock.mockImplementation(async (_tab: number, method: string, params: Record<string, unknown>) => {
      if (method === "DOM.getBoxModel") return { model: boxModel };
      if (method === "DOM.scrollIntoViewIfNeeded") return undefined;
      if (method === "Input.dispatchMouseEvent") {
        dispatched.push({ type: params.type as string, x: params.x as number, y: params.y as number });
        return undefined;
      }
      return undefined;
    });
    const result = await m.clickAxNode(1, 102);
    // Center of [10..30, 10..20] = (20, 15)
    expect(result).toMatchObject({ clicked: true, backendDOMNodeId: 102, x: 20, y: 15 });
    expect(dispatched.map((d) => d.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(dispatched.every((d) => d.x === 20 && d.y === 15)).toBe(true);
  });

  it("throws a clear error when the node no longer exists (DOM.getBoxModel fails)", async () => {
    const m = await load();
    sendMock.mockImplementation(async (_tab: number, method: string) => {
      if (method === "DOM.getBoxModel") throw new Error("No node with id 999");
      return undefined;
    });
    await expect(m.clickAxNode(1, 999)).rejects.toThrow(/no longer exists/);
  });

  it("rejects non-positive node ids at the input boundary (handled by tool, not here)", async () => {
    // clickAxNode itself trusts its input; the tool handler validates. Test
    // here is that 0 / negative would still call DOM.getBoxModel — and the
    // call would fail with whatever CDP says.
    const m = await load();
    sendMock.mockImplementation(async () => { throw new Error("Invalid node id 0"); });
    await expect(m.clickAxNode(1, 0)).rejects.toThrow();
  });
});
