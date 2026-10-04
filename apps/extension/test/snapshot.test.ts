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

interface SweepItem { backendNodeId: number; tag: string; text: string; outsideScope?: boolean }

// Scripts the CDP surface buildSnapshot touches. The sweep is modeled the
// way the extension drives it: the finder returns an array handle, labels
// come back by value, each element handle describes to a backendNodeId.
function scriptCdp(
  axNodes: Raw[],
  opts: { sweep?: SweepItem[]; scope?: { matchNodeId: number; backendNodeId: number } } = {}
) {
  const sweep = opts.sweep ?? [];
  let found: SweepItem[] = [];
  sendMock.mockImplementation(async (_tabId: number, method: string, params: Record<string, any> = {}) => {
    switch (method) {
      case "Accessibility.enable": return {};
      case "Accessibility.getFullAXTree": return ax(axNodes);
      case "DOM.getDocument": return { root: { nodeId: 1, backendNodeId: 1, nodeName: "HTML" } };
      case "DOM.querySelector": return { nodeId: opts.scope?.matchNodeId ?? 0 };
      case "DOM.resolveNode": return { object: { objectId: "scope-obj" } };
      case "DOM.describeNode":
        if (typeof params.objectId === "string" && params.objectId.startsWith("sweep-el-")) {
          return { node: { backendNodeId: found[Number(params.objectId.slice(9))].backendNodeId } };
        }
        return { node: { backendNodeId: opts.scope?.backendNodeId ?? 0 } };
      case "Runtime.evaluate":
        found = sweep;
        return { result: { objectId: "sweep-arr" } };
      case "Runtime.callFunctionOn":
        if (params.objectId === "scope-obj") {
          found = sweep.filter((i) => !i.outsideScope);
          return { result: { objectId: "sweep-arr" } };
        }
        return { result: { value: found.map(({ tag, text }) => ({ tag, text })) } };
      case "Runtime.getProperties":
        return {
          result: [
            ...found.map((_, i) => ({ name: String(i), value: { objectId: `sweep-el-${i}` } })),
            { name: "length", value: { type: "number", value: found.length } }
          ]
        };
      case "Runtime.releaseObjectGroup": return {};
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
    // Sweep finds two elements; one (backendNodeId 103) already has an AX ref.
    scriptCdp(FIXTURE, {
      sweep: [
        { backendNodeId: 200, tag: "div", text: "Open card" },
        { backendNodeId: 103, tag: "span", text: "Dup of Save" }
      ]
    });
    const m = await load();
    const data = await m.buildSnapshot(42, {});

    const sweepNodes = data.nodes.filter((n) => n.source === "sweep");
    expect(sweepNodes.length).toBe(1); // 103 deduped against the Save button
    expect(sweepNodes[0]).toMatchObject({ role: "clickable", name: "Open card" });
    expect(data.refs[sweepNodes[0].ref!]).toMatchObject({ tabId: 42, backendNodeId: 200, role: "clickable" });
  });

  it("sweep reads element handles: no full DOM walk, nothing written to the page, handles released", async () => {
    scriptCdp(FIXTURE, { sweep: [{ backendNodeId: 200, tag: "div", text: "Open card" }] });
    const m = await load();
    await m.buildSnapshot(42, {});
    const calls = sendMock.mock.calls.map((c) => [c[1], c[2]] as [string, Record<string, unknown>]);
    expect(calls.some(([method, p]) => method === "DOM.getDocument" && p?.depth === -1)).toBe(false);
    expect(evalInTabMock).not.toHaveBeenCalled(); // no mark/unmark scripts
    const evaluated = calls.filter(([method]) => method === "Runtime.evaluate").map(([, p]) => String(p.expression));
    expect(evaluated.some((e) => e.includes("setAttribute"))).toBe(false);
    expect(calls.some(([method]) => method === "Runtime.releaseObjectGroup")).toBe(true);
  });

  it("scope bounds BOTH the AX subtree and the sweep — no actionable refs outside it", async () => {
    // Sweep finds one element inside the scoped subtree and one outside; the
    // scoped finder runs on the scope element's handle and returns only the
    // inside one.
    scriptCdp(FIXTURE, {
      sweep: [
        { backendNodeId: 300, tag: "div", text: "Inside scope" },
        { backendNodeId: 301, tag: "div", text: "Outside scope", outsideScope: true }
      ],
      scope: { matchNodeId: 5, backendNodeId: 101 }
    });
    const m = await load();
    const data = await m.buildSnapshot(42, { scope: "#whatever" });

    // AX tree restricted to the heading subtree
    expect(data.nodes.filter((n) => n.source !== "sweep").map((n) => n.role)).toEqual(["heading"]);
    // Sweep restricted to the same subtree — "Outside scope" must not leak
    const sweepNames = data.nodes.filter((n) => n.source === "sweep").map((n) => n.name);
    expect(sweepNames).toEqual(["Inside scope"]);
    const sweepEntries = Object.values(data.refs).filter((e) => e.role === "clickable");
    expect(sweepEntries.map((e) => e.backendNodeId)).toEqual([300]);
    // The scoped sweep ran on the scope element, not the whole document.
    expect(sendMock.mock.calls.some((c) => c[1] === "Runtime.callFunctionOn" && c[2]?.objectId === "scope-obj")).toBe(true);
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


describe("ref healing after snapshot filtering", () => {
  it("keeps the full AX ordinal when earlier duplicate siblings are elided", async () => {
    const buttons = Array.from({ length: 21 }, (_, i) => ({ nodeId: `b${i}`, ignored: false, role: { value: "button" }, name: { value: "Edit" }, backendDOMNodeId: 200 + i }));
    const separator = { nodeId: "heading", ignored: false, role: { value: "heading" }, name: { value: "Last row" }, backendDOMNodeId: 300 };
    const last = { nodeId: "last", ignored: false, role: { value: "button" }, name: { value: "Edit" }, backendDOMNodeId: 400 };
    const nodes = [{ nodeId: "root", ignored: false, role: { value: "RootWebArea" }, backendDOMNodeId: 100, childIds: [...buttons.map(b => b.nodeId), "heading", "last"] }, ...buttons, separator, last];
    scriptCdp(nodes);
    const { buildSnapshot, findBackendNodeByRoleName } = await load();
    const snap = await buildSnapshot(41, { interactiveOnly: true });
    const entry = Object.values(snap.refs).find(r => r.backendNodeId === 400)!;
    expect(snap.nodes.some(n => n.role === "elided")).toBe(true);
    expect(entry.nth).toBe(21);
    scriptCdp(nodes.map(n => ({ ...n, backendDOMNodeId: n.backendDOMNodeId + 1000 })));
    expect(await findBackendNodeByRoleName(41, entry.role, entry.name, entry.nth ?? 0)).toBe(1400);
  });
});
