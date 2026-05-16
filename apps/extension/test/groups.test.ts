// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// Per test we mock chrome.* with the bits the module reads.
let stored: Record<string, unknown>;
let windowsDb: Record<number, { id: number; tabs: Array<{ id: number; active: boolean; windowId: number }> }>;
let tabsDb:    Record<number, { id: number; active: boolean; windowId: number }>;
let nextWindowId: number;
let nextTabId: number;

function setupChrome() {
  stored = {};
  windowsDb = {};
  tabsDb = {};
  nextWindowId = 1000;
  nextTabId = 2000;
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(stored, obj); })
      }
    },
    windows: {
      create: vi.fn(async ({ url }: { url: string }) => {
        const id = ++nextWindowId;
        const tabId = ++nextTabId;
        const tab = { id: tabId, active: true, windowId: id };
        tabsDb[tabId] = tab;
        windowsDb[id] = { id, tabs: [tab] };
        return { id, tabs: [tab] };
      }),
      get: vi.fn(async (id: number, _opts?: unknown) => {
        const w = windowsDb[id];
        if (!w) throw new Error(`No window with id ${id}`);
        return w;
      }),
      remove: vi.fn(async (id: number) => {
        if (!windowsDb[id]) throw new Error(`No window ${id}`);
        for (const t of windowsDb[id].tabs) delete tabsDb[t.id];
        delete windowsDb[id];
      }),
      onRemoved: { addListener: vi.fn() }
    },
    tabs: {
      query: vi.fn(async ({ active, windowId }: { active?: boolean; windowId?: number }) => {
        return Object.values(tabsDb).filter((t) =>
          (active === undefined || t.active === active) &&
          (windowId === undefined || t.windowId === windowId)
        );
      })
    }
  };
}

async function freshModule() {
  setupChrome();
  vi.resetModules();
  return await import("../src/browser/groups");
}

describe("groups — create / list / close", () => {
  it("create opens a window and persists the record", async () => {
    const m = await freshModule();
    const rec = await m.createGroup("bidsmith-h01", { url: "https://example.com" });
    expect(rec.name).toBe("bidsmith-h01");
    expect(typeof rec.windowId).toBe("number");
    const list = await m.listGroups();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("bidsmith-h01");
    expect(list[0].alive).toBe(true);
  });

  it("create rejects names that don't match [a-z0-9][a-z0-9_.-]{0,63}", async () => {
    const m = await freshModule();
    await expect(m.createGroup("")).rejects.toThrow(/Group name must match/);
    await expect(m.createGroup("Invalid Spaces")).rejects.toThrow();
    await expect(m.createGroup("_starts-with-underscore")).rejects.toThrow();
  });

  it("create on an already-alive name throws", async () => {
    const m = await freshModule();
    await m.createGroup("dup");
    await expect(m.createGroup("dup")).rejects.toThrow(/already exists/);
  });

  it("create on an orphan name (window gone) overwrites the orphan record", async () => {
    const m = await freshModule();
    const orig = await m.createGroup("ghost");
    // Manually delete the window — simulate user closing it.
    delete windowsDb[orig.windowId];
    const fresh = await m.createGroup("ghost");
    expect(fresh.windowId).not.toBe(orig.windowId);
    const list = await m.listGroups();
    expect(list).toHaveLength(1);
  });

  it("list reports alive vs orphan correctly", async () => {
    const m = await freshModule();
    const live = await m.createGroup("alive");
    const dead = await m.createGroup("dead");
    delete windowsDb[dead.windowId];
    const list = await m.listGroups();
    expect(list.find((g) => g.name === "alive")?.alive).toBe(true);
    expect(list.find((g) => g.name === "dead")?.alive).toBe(false);
  });

  it("close removes the binding + the window", async () => {
    const m = await freshModule();
    const rec = await m.createGroup("close-me");
    const result = await m.closeGroup("close-me");
    expect(result.windowExisted).toBe(true);
    expect(windowsDb[rec.windowId]).toBeUndefined();
    const list = await m.listGroups();
    expect(list).toHaveLength(0);
  });

  it("close on an unknown group throws", async () => {
    const m = await freshModule();
    await expect(m.closeGroup("never-made")).rejects.toThrow(/not found/);
  });

  it("close on an orphan group succeeds and reports windowExisted=false", async () => {
    const m = await freshModule();
    const rec = await m.createGroup("orphan");
    delete windowsDb[rec.windowId];
    const result = await m.closeGroup("orphan");
    expect(result.closed).toBe(true);
    expect(result.windowExisted).toBe(false);
  });

  it("resolveGroupTarget returns the active tab in the group's window", async () => {
    const m = await freshModule();
    await m.createGroup("target-test");
    const tab = await m.resolveGroupTarget("target-test");
    expect(tab.active).toBe(true);
  });

  it("resolveGroupTarget throws clearly when the window is gone", async () => {
    const m = await freshModule();
    const rec = await m.createGroup("vanished");
    delete windowsDb[rec.windowId];
    await expect(m.resolveGroupTarget("vanished")).rejects.toThrow(/window .* is gone/);
  });

  it("resolveGroupTarget throws when the group name is unknown", async () => {
    const m = await freshModule();
    await expect(m.resolveGroupTarget("missing")).rejects.toThrow(/not found/);
  });
});
