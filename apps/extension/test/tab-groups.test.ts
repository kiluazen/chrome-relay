// @vitest-environment jsdom
//
// Tab groups are Chrome's native UI primitive (the colored, collapsible
// folder of tabs in the tab bar). Distinct from workspaces (named
// windows). The browser-side module wraps chrome.tabs.group +
// chrome.tabGroups; here we mock both with the behavior the module reads.
import { describe, it, expect, vi } from "vitest";

let stored: Record<string, unknown>;
let groupsDb: Record<number, { id: number; title?: string; color?: string; windowId: number; collapsed?: boolean }>;
let tabsDb:   Record<number, { id: number; groupId: number; active: boolean; windowId: number }>;
let nextGroupId: number;
let nextTabId: number;

function setupChrome() {
  stored = {};
  groupsDb = {};
  tabsDb = {};
  nextGroupId = 5000;
  nextTabId = 100;
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(stored, obj); })
      }
    },
    tabs: {
      group: vi.fn(async ({ tabIds, groupId, createProperties }: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
        const windowId = createProperties?.windowId ?? 1;
        const id = groupId ?? ++nextGroupId;
        if (!groupsDb[id]) {
          groupsDb[id] = { id, windowId };
        }
        for (const tabId of tabIds) {
          if (!tabsDb[tabId]) tabsDb[tabId] = { id: tabId, groupId: id, active: false, windowId };
          else tabsDb[tabId].groupId = id;
        }
        return id;
      }),
      ungroup: vi.fn(async (tabIds: number[]) => {
        for (const id of tabIds) {
          if (tabsDb[id]) tabsDb[id].groupId = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE
        }
      }),
      query: vi.fn(async ({ groupId }: { groupId?: number }) => {
        return Object.values(tabsDb).filter((t) => groupId === undefined || t.groupId === groupId);
      })
    },
    tabGroups: {
      get: vi.fn(async (id: number) => {
        const g = groupsDb[id];
        if (!g) throw new Error(`No tab-group with id ${id}`);
        return g;
      }),
      update: vi.fn(async (id: number, props: { title?: string; color?: string; collapsed?: boolean }) => {
        const g = groupsDb[id];
        if (!g) throw new Error(`No tab-group with id ${id}`);
        Object.assign(g, props);
        return g;
      }),
      onRemoved: { addListener: vi.fn() }
    }
  };
}

async function freshModule() {
  setupChrome();
  vi.resetModules();
  return await import("../src/browser/tab-groups");
}

function seedTabs(ids: number[], windowId = 1) {
  for (const id of ids) tabsDb[id] = { id, groupId: -1, active: false, windowId };
}

describe("tab-groups — create / list / close / add / remove", () => {
  it("create groups the given tabs, applies title + color, persists the record", async () => {
    const m = await freshModule();
    seedTabs([10, 11, 12]);
    const rec = await m.createTabGroup("research", { tabIds: [10, 11, 12], color: "cyan" });
    expect(rec.name).toBe("research");
    expect(typeof rec.groupId).toBe("number");
    const g = groupsDb[rec.groupId];
    expect(g.title).toBe("research");
    expect(g.color).toBe("cyan");
    expect(tabsDb[10].groupId).toBe(rec.groupId);
    expect(tabsDb[11].groupId).toBe(rec.groupId);
  });

  it("create rejects invalid names", async () => {
    const m = await freshModule();
    seedTabs([10]);
    await expect(m.createTabGroup("", { tabIds: [10] })).rejects.toThrow(/Tab-group name must match/);
    await expect(m.createTabGroup("Has Spaces", { tabIds: [10] })).rejects.toThrow();
  });

  it("create rejects empty tabIds", async () => {
    const m = await freshModule();
    await expect(m.createTabGroup("empty", { tabIds: [] })).rejects.toThrow(/at least one tabId/);
  });

  it("create on an already-alive name throws", async () => {
    const m = await freshModule();
    seedTabs([10, 11]);
    await m.createTabGroup("dup", { tabIds: [10] });
    await expect(m.createTabGroup("dup", { tabIds: [11] })).rejects.toThrow(/already exists/);
  });

  it("create on an orphan name (group gone) overwrites the record", async () => {
    const m = await freshModule();
    seedTabs([10, 11]);
    const orig = await m.createTabGroup("ghost", { tabIds: [10] });
    delete groupsDb[orig.groupId];
    const fresh = await m.createTabGroup("ghost", { tabIds: [11] });
    expect(fresh.groupId).not.toBe(orig.groupId);
  });

  it("list reports tabCount, color, windowId, alive status", async () => {
    const m = await freshModule();
    seedTabs([10, 11]);
    const rec = await m.createTabGroup("a", { tabIds: [10, 11], color: "blue" });
    const list = await m.listTabGroups();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "a", tabCount: 2, color: "blue", alive: true });
    delete groupsDb[rec.groupId];
    const list2 = await m.listTabGroups();
    expect(list2[0].alive).toBe(false);
  });

  it("close ungroups all tabs and removes the binding", async () => {
    const m = await freshModule();
    seedTabs([10, 11, 12]);
    const rec = await m.createTabGroup("close-me", { tabIds: [10, 11, 12] });
    const r = await m.closeTabGroup("close-me");
    expect(r.closed).toBe(true);
    expect(r.ungroupedTabs).toBe(3);
    expect(tabsDb[10].groupId).toBe(-1);
    expect(tabsDb[11].groupId).toBe(-1);
    const list = await m.listTabGroups();
    expect(list).toHaveLength(0);
    // Use rec to keep typecheck happy even though we don't assert on it here.
    expect(typeof rec.groupId).toBe("number");
  });

  it("close on unknown name throws", async () => {
    const m = await freshModule();
    await expect(m.closeTabGroup("nope")).rejects.toThrow(/not found/);
  });

  it("add extends an existing group", async () => {
    const m = await freshModule();
    seedTabs([10, 11, 12]);
    await m.createTabGroup("g", { tabIds: [10] });
    const r = await m.addToTabGroup("g", [11, 12]);
    expect(r.added).toBe(2);
    expect(tabsDb[11].groupId).toBe(r.groupId);
    expect(tabsDb[12].groupId).toBe(r.groupId);
  });

  it("add on unknown group throws", async () => {
    const m = await freshModule();
    seedTabs([10]);
    await expect(m.addToTabGroup("missing", [10])).rejects.toThrow(/not found/);
  });

  it("remove ungroups specific tabs (regardless of which group)", async () => {
    const m = await freshModule();
    seedTabs([10, 11]);
    await m.createTabGroup("g", { tabIds: [10, 11] });
    const r = await m.removeFromTabGroup([10]);
    expect(r.removed).toBe(1);
    expect(tabsDb[10].groupId).toBe(-1);
  });

  it("resolveTabGroupTarget returns active tab if any are active, else first", async () => {
    const m = await freshModule();
    seedTabs([10, 11, 12]);
    await m.createTabGroup("target", { tabIds: [10, 11, 12] });
    // No active → first
    const first = await m.resolveTabGroupTarget("target");
    expect(first.id).toBe(10);
    // Mark 11 active → wins
    tabsDb[11].active = true;
    const active = await m.resolveTabGroupTarget("target");
    expect(active.id).toBe(11);
  });

  it("resolveTabGroupTarget throws on unknown name", async () => {
    const m = await freshModule();
    await expect(m.resolveTabGroupTarget("nope")).rejects.toThrow(/not found/);
  });

  it("resolveTabGroupTarget throws when the group is gone", async () => {
    const m = await freshModule();
    seedTabs([10]);
    const rec = await m.createTabGroup("vanished", { tabIds: [10] });
    delete groupsDb[rec.groupId];
    await expect(m.resolveTabGroupTarget("vanished")).rejects.toThrow(/is gone/);
  });
});
