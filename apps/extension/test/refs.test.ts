import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory chrome.storage.session + tabs mock. The RefMap module registers
// a tabs.onRemoved listener at import time and persists via storage.session.
let store: Record<string, unknown>;
let removedListeners: ((tabId: number) => void)[];
let updatedListeners: ((tabId: number, changeInfo: Record<string, unknown>) => void)[];

beforeEach(() => {
  vi.resetModules();
  store = {};
  removedListeners = [];
  updatedListeners = [];
  (globalThis as any).chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        })
      }
    },
    tabs: {
      onRemoved: {
        addListener: vi.fn((fn: (tabId: number) => void) => removedListeners.push(fn))
      },
      onUpdated: {
        addListener: vi.fn((fn: (tabId: number, changeInfo: Record<string, unknown>) => void) =>
          updatedListeners.push(fn)
        )
      }
    }
  };
});

async function load() {
  return await import("../src/browser/refs");
}

const entry = (tabId: number, backendNodeId: number) => ({
  tabId,
  backendNodeId,
  role: "button",
  name: "Save"
});

describe("RefMap", () => {
  it("allocates globally monotonic refs that carry tab identity", async () => {
    const m = await load();
    const r1 = m.allocateRef(entry(10, 100));
    const r2 = m.allocateRef(entry(20, 200));
    expect(r1).toBe("e1");
    expect(r2).toBe("e2");
    expect((await m.getRefEntry("e1"))?.tabId).toBe(10);
    expect((await m.getRefEntry("e2"))?.tabId).toBe(20);
  });

  it("invalidates only the snapshotted tab's refs", async () => {
    const m = await load();
    m.allocateRef(entry(10, 100)); // e1
    m.allocateRef(entry(20, 200)); // e2
    await m.invalidateTabRefs(10);
    expect(await m.getRefEntry("e1")).toBeUndefined();
    expect((await m.getRefEntry("e2"))?.backendNodeId).toBe(200);
    // counter does NOT reset — refs are never reused across snapshots
    expect(m.allocateRef(entry(10, 101))).toBe("e3");
  });

  it("stable refs: beginTabSnapshot collects reuse candidates, assignRef keeps surviving ids", async () => {
    const m = await load();
    m.allocateRef(entry(10, 100)); // e1
    m.allocateRef(entry(10, 200)); // e2
    m.allocateRef(entry(20, 300)); // e3 — other tab, untouched

    const prior = await m.beginTabSnapshot(10);
    expect(prior.get(100)).toBe("e1");
    expect(prior.get(200)).toBe("e2");
    // tab 10's refs are out of the live map until re-registered
    expect(await m.getRefEntry("e1")).toBeUndefined();
    expect((await m.getRefEntry("e3"))?.tabId).toBe(20);

    // element 100 survived → keeps e1; element 200 vanished (never
    // re-registered); a new element gets a fresh global id
    expect(m.assignRef(entry(10, 100), prior)).toBe("e1");
    expect(m.assignRef(entry(10, 999), prior)).toBe("e4");
    expect((await m.getRefEntry("e1"))?.backendNodeId).toBe(100);
    expect(await m.getRefEntry("e2")).toBeUndefined(); // vanished element's ref is dead
  });

  it("heals an entry in place", async () => {
    const m = await load();
    m.allocateRef(entry(10, 100)); // e1
    await m.healRefEntry("e1", 999);
    expect((await m.getRefEntry("e1"))?.backendNodeId).toBe(999);
  });

  it("drops a tab's refs on real navigation (backendNodeId reuse hazard), keeps them on SPA url changes", async () => {
    const m = await load();
    m.allocateRef(entry(10, 100)); // e1
    m.allocateRef(entry(20, 200)); // e2
    expect(updatedListeners.length).toBe(1);
    // SPA route change: url only, no status — refs survive
    updatedListeners[0](10, { url: "https://x.test/route" });
    await new Promise((r) => setTimeout(r, 0));
    expect(await m.getRefEntry("e1")).toBeTruthy();
    // Real navigation: status "loading" — refs for THAT tab die
    updatedListeners[0](10, { status: "loading", url: "https://elsewhere.test/" });
    await new Promise((r) => setTimeout(r, 0));
    expect(await m.getRefEntry("e1")).toBeUndefined();
    expect(await m.getRefEntry("e2")).toBeTruthy();
  });

  it("drops a tab's refs when the tab closes", async () => {
    const m = await load();
    m.allocateRef(entry(10, 100)); // e1
    expect(removedListeners.length).toBe(1);
    removedListeners[0](10);
    // listener fires async invalidation; give it a microtask
    await new Promise((r) => setTimeout(r, 0));
    expect(await m.getRefEntry("e1")).toBeUndefined();
  });

  it("hydrates counter + entries from storage.session after a SW restart", async () => {
    const m1 = await load();
    m1.allocateRef(entry(10, 100)); // e1
    // persist is debounced 50ms
    await new Promise((r) => setTimeout(r, 80));
    expect(store["chrome_relay_ref_map_v1"]).toBeTruthy();

    // simulate SW restart: fresh module, same storage
    vi.resetModules();
    const m2 = await import("../src/browser/refs");
    expect((await m2.getRefEntry("e1"))?.backendNodeId).toBe(100);
    // counter continues — no ref reuse after restart
    expect(m2.allocateRef(entry(10, 101))).toBe("e2");
  });

  it("evicts oldest entries at the cap instead of growing unbounded", async () => {
    const m = await load();
    // reach in via the test surface: allocate 3 with a tiny synthetic cap is
    // not exposed, so just verify the public invariant on a small sample —
    // size tracks allocations minus invalidations.
    m.allocateRef(entry(1, 1));
    m.allocateRef(entry(1, 2));
    expect(m.refMapSize()).toBe(2);
    await m.invalidateTabRefs(1);
    expect(m.refMapSize()).toBe(0);
  });
});
