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

// Helper: synthesize a CDP raw AX response. Children referenced by AX id.
function rawTree(): Array<Record<string, unknown>> {
  return [
    {
      nodeId: "1",
      ignored: false,
      role: { type: "internalRole", value: "WebArea" },
      backendDOMNodeId: 100,
      childIds: ["2", "3", "4"]
    },
    {
      nodeId: "2",
      ignored: false,
      role: { type: "internalRole", value: "heading" },
      name: { type: "computedString", value: "Welcome" },
      backendDOMNodeId: 101,
      childIds: []
    },
    {
      nodeId: "3",
      ignored: false,
      role: { type: "internalRole", value: "button" },
      name: { type: "computedString", value: "Save" },
      properties: [{ name: "disabled", value: { type: "boolean", value: false } }],
      backendDOMNodeId: 102,
      childIds: []
    },
    {
      nodeId: "4",
      ignored: false,
      role: { type: "internalRole", value: "textbox" },
      name: { type: "computedString", value: "Email" },
      value: { type: "string", value: "you@example.com" },
      properties: [{ name: "required", value: { type: "boolean", value: true } }],
      backendDOMNodeId: 103,
      childIds: []
    },
    {
      nodeId: "5",
      ignored: true,
      role: { type: "internalRole", value: "presentation" },
      backendDOMNodeId: 104,
      childIds: []
    }
  ];
}

describe("getAxTree", () => {
  it("returns compact nodes with id=backendDOMNodeId + role + name", async () => {
    const m = await load();
    sendMock.mockImplementation(async (_tab: number, method: string) => {
      if (method === "Accessibility.enable") return undefined;
      if (method === "Accessibility.getFullAXTree") return { nodes: rawTree() };
      throw new Error("unexpected " + method);
    });
    const result = await m.getAxTree(1);
    // WebArea root with 3 children (heading, button, textbox). ignored=true presentation drops out.
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0].role).toBe("WebArea");
    expect(result.tree[0].children?.map((c) => c.role)).toEqual(["heading", "button", "textbox"]);
    const button = result.tree[0].children![1];
    expect(button).toMatchObject({ id: 102, role: "button", name: "Save" });
  });

  it("interactiveOnly filters out non-actionable roles", async () => {
    const m = await load();
    sendMock.mockImplementation(async (_tab: number, method: string) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: rawTree() };
      return undefined;
    });
    const result = await m.getAxTree(1, { interactiveOnly: true });
    // WebArea + heading should be filtered; button + textbox surface as top-level.
    const roles = result.tree.map((n) => n.role);
    expect(roles).toEqual(["button", "textbox"]);
  });

  it("textbox value is included; state has required=true", async () => {
    const m = await load();
    sendMock.mockImplementation(async (_tab: number, method: string) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: rawTree() };
      return undefined;
    });
    const result = await m.getAxTree(1, { interactiveOnly: true });
    const textbox = result.tree.find((n) => n.role === "textbox")!;
    expect(textbox.value).toBe("you@example.com");
    expect(textbox.state).toMatchObject({ required: true });
  });

  it("rootRole scopes to the first matching subtree", async () => {
    const m = await load();
    sendMock.mockImplementation(async (_tab: number, method: string) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: rawTree() };
      return undefined;
    });
    const result = await m.getAxTree(1, { rootRole: "button" });
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0].role).toBe("button");
  });

  it("nodeCount reflects the compacted tree size", async () => {
    const m = await load();
    sendMock.mockImplementation(async (_tab: number, method: string) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: rawTree() };
      return undefined;
    });
    const result = await m.getAxTree(1);
    expect(result.nodeCount).toBe(4); // WebArea + 3 visible children, presentation dropped
  });

  it("captures url from chrome.tabs for response metadata", async () => {
    const m = await load();
    sendMock.mockImplementation(async (_tab: number, method: string) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: rawTree() };
      return undefined;
    });
    const result = await m.getAxTree(1);
    expect(result.url).toBe("https://example.com");
  });

  it("frameStrategy='top' when includeSubframes is not set", async () => {
    const m = await load();
    sendMock.mockImplementation(async (_tab: number, method: string) => {
      if (method === "Accessibility.getFullAXTree") return { nodes: rawTree() };
      return undefined;
    });
    const result = await m.getAxTree(1);
    expect(result.frameStrategy).toBe("top");
  });
});

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
