// @vitest-environment jsdom
//
// Pre-0.4.0 this file was test/groups.test.ts and the module was groups.ts.
// Workspaces are the same primitive (named Chrome windows for cross-agent
// isolation), just renamed because "group" now refers to Chrome's native
// tab-group UI element (see tab-groups.test.ts).
import { describe, it, expect, beforeEach, vi } from "vitest";

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
  return await import("../src/browser/workspaces");
}

describe("workspaces — create / list / close", () => {
  it("create opens a window and persists the record", async () => {
    const m = await freshModule();
    const rec = await m.createWorkspace("bidsmith-h01", { url: "https://example.com" });
    expect(rec.name).toBe("bidsmith-h01");
    expect(typeof rec.windowId).toBe("number");
    const list = await m.listWorkspaces();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("bidsmith-h01");
    expect(list[0].alive).toBe(true);
  });

  it("create rejects names that don't match [a-z0-9][a-z0-9_.-]{0,63}", async () => {
    const m = await freshModule();
    await expect(m.createWorkspace("")).rejects.toThrow(/Workspace name must match/);
    await expect(m.createWorkspace("Invalid Spaces")).rejects.toThrow();
    await expect(m.createWorkspace("_starts-with-underscore")).rejects.toThrow();
  });

  it("create on an already-alive name throws", async () => {
    const m = await freshModule();
    await m.createWorkspace("dup");
    await expect(m.createWorkspace("dup")).rejects.toThrow(/already exists/);
  });

  it("create on an orphan name (window gone) overwrites the orphan record", async () => {
    const m = await freshModule();
    const orig = await m.createWorkspace("ghost");
    delete windowsDb[orig.windowId];
    const fresh = await m.createWorkspace("ghost");
    expect(fresh.windowId).not.toBe(orig.windowId);
    const list = await m.listWorkspaces();
    expect(list).toHaveLength(1);
  });

  it("list reports alive vs orphan correctly", async () => {
    const m = await freshModule();
    await m.createWorkspace("alive");
    const dead = await m.createWorkspace("dead");
    delete windowsDb[dead.windowId];
    const list = await m.listWorkspaces();
    expect(list.find((w) => w.name === "alive")?.alive).toBe(true);
    expect(list.find((w) => w.name === "dead")?.alive).toBe(false);
  });

  it("close removes the binding + the window", async () => {
    const m = await freshModule();
    const rec = await m.createWorkspace("close-me");
    const result = await m.closeWorkspace("close-me");
    expect(result.windowExisted).toBe(true);
    expect(windowsDb[rec.windowId]).toBeUndefined();
    const list = await m.listWorkspaces();
    expect(list).toHaveLength(0);
  });

  it("close on an unknown workspace throws", async () => {
    const m = await freshModule();
    await expect(m.closeWorkspace("never-made")).rejects.toThrow(/not found/);
  });

  it("close on an orphan workspace succeeds and reports windowExisted=false", async () => {
    const m = await freshModule();
    const rec = await m.createWorkspace("orphan");
    delete windowsDb[rec.windowId];
    const result = await m.closeWorkspace("orphan");
    expect(result.closed).toBe(true);
    expect(result.windowExisted).toBe(false);
  });

  it("resolveWorkspaceTarget returns the active tab in the workspace's window", async () => {
    const m = await freshModule();
    await m.createWorkspace("target-test");
    const tab = await m.resolveWorkspaceTarget("target-test");
    expect(tab.active).toBe(true);
  });

  it("resolveWorkspaceTarget throws clearly when the window is gone", async () => {
    const m = await freshModule();
    const rec = await m.createWorkspace("vanished");
    delete windowsDb[rec.windowId];
    await expect(m.resolveWorkspaceTarget("vanished")).rejects.toThrow(/window .* is gone/);
  });

  it("resolveWorkspaceTarget throws when the workspace name is unknown", async () => {
    const m = await freshModule();
    await expect(m.resolveWorkspaceTarget("missing")).rejects.toThrow(/not found/);
  });
});
