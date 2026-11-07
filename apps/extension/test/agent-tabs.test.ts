// The "Agent" tab group for `navigate --new` tabs, in Chrome and in Opera.
// Opera (tab islands) dissolves any group with fewer than two tabs the
// moment it is created (measured on Opera 139: tabs.group([one]) returns an
// id, tabGroups.get(id) then throws "No group with id"). The mock applies
// that rule when minGroupSize is 2.
import { describe, it, expect, vi } from "vitest";

interface Tab { id: number; groupId: number; windowId: number }
interface Group { id: number; windowId: number; title?: string; color?: string }

function setupBrowser(minGroupSize: 1 | 2) {
  const tabs: Record<number, Tab> = {};
  const groups: Record<number, Group> = {};
  let nextGroupId = 900;
  let nextTabId = 10;

  const dissolveSmall = () => {
    for (const g of Object.values(groups)) {
      const members = Object.values(tabs).filter((t) => t.groupId === g.id);
      if (members.length < minGroupSize) {
        for (const t of members) t.groupId = -1;
        delete groups[g.id];
      }
    }
  };

  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => {
        if (!tabs[id]) throw new Error(`No tab with id: ${id}.`);
        return { ...tabs[id] };
      }),
      group: vi.fn(async ({ tabIds, groupId, createProperties }: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
        let id = groupId;
        if (id === undefined) {
          id = ++nextGroupId;
          groups[id] = { id, windowId: createProperties?.windowId ?? tabs[tabIds[0]].windowId };
        } else if (!groups[id]) {
          throw new Error(`No group with id: ${id}.`);
        }
        for (const t of tabIds) tabs[t].groupId = id;
        dissolveSmall();
        return id;
      })
    },
    tabGroups: {
      get: vi.fn(async (id: number) => {
        if (!groups[id]) throw new Error(`No group with id: ${id}.`);
        return { ...groups[id] };
      }),
      query: vi.fn(async ({ windowId, title }: { windowId?: number; title?: string }) =>
        Object.values(groups).filter((g) => (windowId === undefined || g.windowId === windowId) && (title === undefined || g.title === title))
      ),
      update: vi.fn(async (id: number, props: Partial<Group>) => {
        if (!groups[id]) throw new Error(`No group with id: ${id}.`);
        Object.assign(groups[id], props);
        return { ...groups[id] };
      })
    }
  };

  const openTab = (windowId = 1): Tab => {
    const t = { id: ++nextTabId, groupId: -1, windowId };
    tabs[t.id] = t;
    return t;
  };
  return { tabs, groups, openTab };
}

async function freshModule() {
  vi.resetModules();
  return await import("../src/browser/agent-tabs");
}

describe("groupAgentTab", () => {
  it("Chrome: the first agent tab starts the Agent group, later ones join it", async () => {
    const b = setupBrowser(1);
    const m = await freshModule();
    const a = b.openTab();
    const gid = await m.groupAgentTab(a as chrome.tabs.Tab);
    expect(gid).toBeDefined();
    expect(b.groups[gid!].title).toBe("Agent");
    const c = b.openTab();
    expect(await m.groupAgentTab(c as chrome.tabs.Tab)).toBe(gid);
    expect(b.tabs[a.id].groupId).toBe(gid);
    expect(b.tabs[c.id].groupId).toBe(gid);
  });

  it("Opera: a lone agent tab waits, the second agent tab forms the group with it", async () => {
    const b = setupBrowser(2);
    const m = await freshModule();
    const a = b.openTab();
    expect(await m.groupAgentTab(a as chrome.tabs.Tab)).toBeUndefined();
    expect(b.tabs[a.id].groupId).toBe(-1);

    const c = b.openTab();
    const gid = await m.groupAgentTab(c as chrome.tabs.Tab);
    expect(gid).toBeDefined();
    expect(b.groups[gid!].title).toBe("Agent");
    expect(b.tabs[a.id].groupId).toBe(gid);
    expect(b.tabs[c.id].groupId).toBe(gid);

    const d = b.openTab();
    expect(await m.groupAgentTab(d as chrome.tabs.Tab)).toBe(gid);
    expect(b.tabs[d.id].groupId).toBe(gid);
  });

  it("Opera: a waiting tab that was closed is not paired", async () => {
    const b = setupBrowser(2);
    const m = await freshModule();
    const a = b.openTab();
    await m.groupAgentTab(a as chrome.tabs.Tab);
    delete b.tabs[a.id];
    const c = b.openTab();
    expect(await m.groupAgentTab(c as chrome.tabs.Tab)).toBeUndefined();
    const d = b.openTab();
    const gid = await m.groupAgentTab(d as chrome.tabs.Tab);
    expect(b.tabs[c.id].groupId).toBe(gid);
    expect(b.tabs[d.id].groupId).toBe(gid);
  });

  it("Opera: tabs in different windows are not paired across windows", async () => {
    const b = setupBrowser(2);
    const m = await freshModule();
    const a = b.openTab(1);
    await m.groupAgentTab(a as chrome.tabs.Tab);
    const c = b.openTab(2);
    expect(await m.groupAgentTab(c as chrome.tabs.Tab)).toBeUndefined();
    expect(b.tabs[a.id].groupId).toBe(-1);
    expect(b.tabs[c.id].groupId).toBe(-1);
  });
});
