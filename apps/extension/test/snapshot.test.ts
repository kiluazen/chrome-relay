// Unified snapshot builder tests — scripted CDP responses, fake RefMap.
import { describe, it, expect, beforeEach, vi } from "vitest";

let sendMock: ReturnType<typeof vi.fn>;
let evalInTabMock: ReturnType<typeof vi.fn>;
let allocated: { ref: string; entry: Record<string, unknown> }[];
let invalidatedTabs: number[];

beforeEach(() => {
  vi.resetModules();
  sendMock = vi.fn();
  evalInTabMock = vi.fn(async () => []); // sweep finds nothing by default
  allocated = [];
  invalidatedTabs = [];
  let counter = 0;
  vi.doMock("../src/browser/cdp", () => ({
    send: sendMock,
    evalInTab: evalInTabMock,
    evalExpression: vi.fn()
  }));
  vi.doMock("../src/browser/refs", () => ({
    assignRef: vi.fn((entry: Record<string, unknown>, prior: Map<number, string>) => {
      const reuse = prior.get(entry.backendNodeId as number);
      if (reuse) {
        allocated.push({ ref: reuse, entry });
        return reuse;
      }
      counter += 1;
      const ref = `e${counter}`;
      allocated.push({ ref, entry });
      return ref;
    }),
    beginTabSnapshot: vi.fn(async (tabId: number) => {
      invalidatedTabs.push(tabId);
      return new Map<number, string>();
    }),
    invalidateTabRefs: vi.fn(),
    getRefEntry: vi.fn(),
    healRefEntry: vi.fn()
  }));
  (globalThis as any).chrome = {
    tabs: { get: vi.fn(async () => ({ title: "Fixture", url: "https://x.test/" })) }
  };
});

async function load() {
  return await import("../src/browser/snapshot");
}

type Raw = Record<string, unknown>;
const ax = (nodes: Raw[]) => ({ nodes });

function scriptCdp(axNodes: Raw[], domRoot?: Raw, scope?: { matchNodeId: number; backendNodeId: number }) {
  sendMock.mockImplementation(async (_tabId: number, method: string) => {
    switch (method) {
      case "Accessibility.enable": return {};
      case "Accessibility.getFullAXTree": return ax(axNodes);
      case "DOM.getDocument": return { root: domRoot ?? { nodeId: 1, backendNodeId: 1, nodeName: "HTML" } };
      case "DOM.querySelector": return { nodeId: scope?.matchNodeId ?? 0 };
      case "DOM.describeNode": return { node: { backendNodeId: scope?.backendNodeId ?? 0 } };
      default: throw new Error(`unscripted CDP method ${method}`);
    }
  });
}

const FIXTURE: Raw[] = [
  { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, backendDOMNodeId: 100, childIds: ["2", "3", "6", "8"] },
  { nodeId: "2", ignored: false, role: { value: "heading" }, name: { value: "Welcome" }, backendDOMNodeId: 101,
    properties: [{ name: "level", value: { type: "integer", value: 1 } }], childIds: ["7"] },
  { nodeId: "3", ignored: false, role: { value: "generic" }, backendDOMNodeId: 102, childIds: ["4", "5"] },
  { nodeId: "4", ignored: false, role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 103, childIds: [] },
  { nodeId: "5", ignored: false, role: { value: "checkbox" }, name: { value: "Agree" }, backendDOMNodeId: 104,
    properties: [{ name: "checked", value: { type: "tristate", value: "true" } }], childIds: [] },
  { nodeId: "6", ignored: true, role: { value: "presentation" }, backendDOMNodeId: 105, childIds: [] },
  // StaticText duplicating its parent heading's name — must drop
  { nodeId: "7", ignored: false, role: { value: "StaticText" }, name: { value: "Welcome" }, backendDOMNodeId: 106, childIds: [] },
  // Second button with the same role+name — nth disambiguation
  { nodeId: "8", ignored: false, role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 107, childIds: [] }
];

describe("buildSnapshot", () => {
  it("builds a collapsed tree: structural nodes promote children, dup text drops", async () => {
    scriptCdp(FIXTURE);
    const m = await load();
    const data = await m.buildSnapshot(42, {});

    expect(data.title).toBe("Fixture");
    expect(data.tabId).toBe(42);
    // RootWebArea and the unnamed generic collapse; StaticText dup drops.
    const roles = data.nodes.map((n) => n.role);
    expect(roles).toEqual(["heading", "button", "checkbox", "button"]);
  });

  it("assigns refs to interactive + named-content roles, with nth on duplicates", async () => {
    scriptCdp(FIXTURE);
    const m = await load();
    const data = await m.buildSnapshot(42, {});

    expect(invalidatedTabs).toEqual([42]); // old refs dropped first
    const heading = data.nodes[0];
    const save1 = data.nodes[1];
    const save2 = data.nodes[3];
    expect(heading.ref).toBeTruthy(); // named content role
    expect(save1.ref).toBeTruthy();
    expect(save2.ref).toBeTruthy();
    expect(data.refs[save1.ref!]).toMatchObject({ tabId: 42, backendNodeId: 103, role: "button", name: "Save" });
    expect(data.refs[save1.ref!].nth).toBeUndefined(); // first occurrence
    expect(data.refs[save2.ref!]).toMatchObject({ backendNodeId: 107, nth: 1 });
  });

  it("renders attrs: level + tristate checked", async () => {
    scriptCdp(FIXTURE);
    const m = await load();
    const data = await m.buildSnapshot(42, {});
    expect(data.nodes[0].attrs).toEqual({ level: 1 });
    expect(data.nodes[2].attrs).toEqual({ checked: true });
  });

  it("interactiveOnly prunes non-ref-bearing nodes but keeps ref-bearing content", async () => {
    scriptCdp(FIXTURE);
    const m = await load();
    const data = await m.buildSnapshot(42, { interactiveOnly: true });
    const roles = data.nodes.map((n) => n.role);
    // heading is ref-bearing (named content role) so it survives -i
    expect(roles).toEqual(["heading", "button", "checkbox", "button"]);
  });

  it("merges sweep extras as 'clickable' nodes with refs, deduped by backendNodeId", async () => {
    // Sweep marks two elements; one (backendNodeId 103) already has an AX ref.
    evalInTabMock.mockImplementation(async (_tabId: number, fn: { name?: string }) => {
      if (fn?.name === "markCursorInteractive") {
        return [
          { i: 0, tag: "div", text: "Open card" },
          { i: 1, tag: "span", text: "Dup of Save" }
        ];
      }
      return { cleaned: true };
    });
    const domRoot: Raw = {
      nodeId: 1, backendNodeId: 1, nodeName: "HTML",
      children: [
        { nodeId: 2, backendNodeId: 200, nodeName: "DIV", attributes: ["data-cr-sweep", "0"] },
        { nodeId: 3, backendNodeId: 103, nodeName: "SPAN", attributes: ["data-cr-sweep", "1"] }
      ]
    };
    scriptCdp(FIXTURE, domRoot);
    const m = await load();
    const data = await m.buildSnapshot(42, {});

    const sweepNodes = data.nodes.filter((n) => n.source === "sweep");
    expect(sweepNodes.length).toBe(1); // 103 deduped against the Save button
    expect(sweepNodes[0]).toMatchObject({ role: "clickable", name: "Open card" });
    expect(data.refs[sweepNodes[0].ref!]).toMatchObject({ tabId: 42, backendNodeId: 200, role: "clickable" });
  });

  it("scope bounds BOTH the AX subtree and the sweep — no actionable refs outside it", async () => {
    // Sweep marks one element inside the scoped subtree and one outside.
    evalInTabMock.mockImplementation(async (_tabId: number, fn: { name?: string }) => {
      if (fn?.name === "markCursorInteractive") {
        return [
          { i: 0, tag: "div", text: "Inside scope" },
          { i: 1, tag: "div", text: "Outside scope" }
        ];
      }
      return { cleaned: true };
    });
    // DOM: scope element (backendNodeId 101 = the heading) contains sweep #0;
    // sweep #1 lives elsewhere on the page.
    const domRoot: Raw = {
      nodeId: 1, backendNodeId: 1, nodeName: "HTML",
      children: [
        {
          nodeId: 5, backendNodeId: 101, nodeName: "H1",
          children: [{ nodeId: 6, backendNodeId: 300, nodeName: "DIV", attributes: ["data-cr-sweep", "0"] }]
        },
        { nodeId: 7, backendNodeId: 301, nodeName: "DIV", attributes: ["data-cr-sweep", "1"] }
      ]
    };
    scriptCdp(FIXTURE, domRoot, { matchNodeId: 5, backendNodeId: 101 });
    const m = await load();
    const data = await m.buildSnapshot(42, { scope: "#whatever" });

    // AX tree restricted to the heading subtree
    expect(data.nodes.filter((n) => n.source !== "sweep").map((n) => n.role)).toEqual(["heading"]);
    // Sweep restricted to the same subtree — "Outside scope" must not leak
    const sweepNames = data.nodes.filter((n) => n.source === "sweep").map((n) => n.name);
    expect(sweepNames).toEqual(["Inside scope"]);
    const sweepEntries = Object.values(data.refs).filter((e) => e.role === "clickable");
    expect(sweepEntries.map((e) => e.backendNodeId)).toEqual([300]);
  });

  it("elides long runs of identical-shape siblings: keep 10 + loud marker, refs only for kept", async () => {
    // 25 named listitems with identical shape (same role, named, no attrs,
    // no children) under the root — a virtualized-table stand-in.
    const rows: Raw[] = Array.from({ length: 25 }, (_, k) => ({
      nodeId: `r${k}`,
      ignored: false,
      role: { value: "listitem" },
      name: { value: `Row ${k}` },
      backendDOMNodeId: 1000 + k,
      childIds: []
    }));
    const fixture: Raw[] = [
      { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, backendDOMNodeId: 100,
        childIds: rows.map((r) => r.nodeId as string) },
      ...rows
    ];
    scriptCdp(fixture);
    const m = await load();
    const data = await m.buildSnapshot(42, {});

    const items = data.nodes.filter((n) => n.role === "listitem");
    const markers = data.nodes.filter((n) => n.role === "elided");
    expect(items.length).toBe(10);
    expect(markers.length).toBe(1);
    expect(markers[0].name).toContain("15 more listitem siblings");
    expect(markers[0].ref).toBeUndefined(); // marker is not actionable
    // refs only allocated for printed rows
    expect(Object.values(data.refs).filter((e) => e.role === "listitem").length).toBe(10);
  });

  it("elide: false prints everything; runs of 20 or fewer never elide", async () => {
    const mk = (n: number): Raw[] => {
      const rows: Raw[] = Array.from({ length: n }, (_, k) => ({
        nodeId: `r${k}`, ignored: false, role: { value: "listitem" },
        name: { value: `Row ${k}` }, backendDOMNodeId: 2000 + k, childIds: []
      }));
      return [
        { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, backendDOMNodeId: 100,
          childIds: rows.map((r) => r.nodeId as string) },
        ...rows
      ];
    };
    scriptCdp(mk(25));
    let m = await load();
    let data = await m.buildSnapshot(42, { elide: false });
    expect(data.nodes.filter((n) => n.role === "listitem").length).toBe(25);

    scriptCdp(mk(20));
    data = await m.buildSnapshot(42, {});
    expect(data.nodes.filter((n) => n.role === "listitem").length).toBe(20);
    expect(data.nodes.filter((n) => n.role === "elided").length).toBe(0);
  });

  it("depth truncates the tree", async () => {
    scriptCdp(FIXTURE);
    const m = await load();
    const data = await m.buildSnapshot(42, { depth: 1 });
    for (const n of data.nodes) expect(n.children).toBeUndefined();
  });
});

describe("findBackendNodeByRoleName", () => {
  it("finds the nth matching role+name in document order", async () => {
    scriptCdp(FIXTURE);
    const m = await load();
    expect(await m.findBackendNodeByRoleName(42, "button", "Save", 0)).toBe(103);
    expect(await m.findBackendNodeByRoleName(42, "button", "Save", 1)).toBe(107);
    expect(await m.findBackendNodeByRoleName(42, "button", "Save", 2)).toBeNull();
    expect(await m.findBackendNodeByRoleName(42, "button", "Nope", 0)).toBeNull();
  });

  it("never heals sweep refs via AX (role 'clickable')", async () => {
    scriptCdp(FIXTURE);
    const m = await load();
    expect(await m.findBackendNodeByRoleName(42, "clickable", "Open card", 0)).toBeNull();
  });
});
