// Tab groups — Chrome's native colored, collapsible folder of tabs that
// lives inside ONE window. Different concept from `workspaces.ts` (which
// represents whole windows for cross-agent isolation). Pre-0.4.0 we only
// had workspaces and called them "groups," which collided with this UI
// primitive that users actually see in their tab bar.
//
// Storage: name → tabGroups groupId (numeric). Chrome's groupId is stable
// across SW restarts but not across browser restarts, so dead entries
// auto-prune via chrome.tabGroups.onRemoved.

const STORAGE_KEY = "chrome_relay_tab_groups_v1";

// Chrome's @types package doesn't currently export the ColorEnum union, so
// we inline it. Source: https://developer.chrome.com/docs/extensions/reference/api/tabGroups#type-Color
export type TabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export interface TabGroupRecord {
  name: string;          // user-chosen identifier
  groupId: number;       // Chrome's tabGroups.id
  createdAt: number;
}

interface TabGroupTable {
  [name: string]: TabGroupRecord;
}

async function loadTable(): Promise<TabGroupTable> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as TabGroupTable) || {};
}

async function saveTable(table: TabGroupTable): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: table });
}

function validName(name: string): void {
  if (!name || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(name)) {
    throw new Error(`Tab-group name must match [a-z0-9][a-z0-9_.-]{0,63}. Got: "${name}"`);
  }
}

export interface CreateTabGroupOpts {
  tabIds: number[];      // must be non-empty; chrome.tabs.group requires at least one tab
  color?: TabGroupColor; // grey, blue, red, yellow, green, pink, purple, cyan, orange
  collapsed?: boolean;
  windowId?: number;     // route the group into a specific window (e.g. a workspace's)
}

export async function createTabGroup(name: string, opts: CreateTabGroupOpts): Promise<TabGroupRecord> {
  validName(name);
  if (!Array.isArray(opts.tabIds) || opts.tabIds.length === 0) {
    throw new Error("createTabGroup requires at least one tabId.");
  }
  const table = await loadTable();
  if (table[name]) {
    try {
      await chrome.tabGroups.get(table[name].groupId);
      throw new Error(
        `Tab-group "${name}" already exists (id ${table[name].groupId}). ` +
          `Run: chrome-relay group close ${name} first, or use 'group add' to extend it.`
      );
    } catch (e) {
      if (e instanceof Error && /already exists/.test(e.message)) throw e;
      // group is gone → silently overwrite below
    }
  }

  const createProps: chrome.tabs.GroupOptions["createProperties"] = {};
  if (typeof opts.windowId === "number") createProps.windowId = opts.windowId;
  const groupId = await chrome.tabs.group({
    tabIds: opts.tabIds,
    createProperties: createProps
  });

  const updateProps: chrome.tabGroups.UpdateProperties = { title: name };
  if (opts.color) updateProps.color = opts.color;
  if (typeof opts.collapsed === "boolean") updateProps.collapsed = opts.collapsed;
  await chrome.tabGroups.update(groupId, updateProps);

  const record: TabGroupRecord = { name, groupId, createdAt: Date.now() };
  table[name] = record;
  await saveTable(table);
  return record;
}

export async function listTabGroups(): Promise<Array<TabGroupRecord & {
  color?: TabGroupColor;
  windowId?: number;
  tabCount: number;
  collapsed?: boolean;
  alive: boolean;
}>> {
  const table = await loadTable();
  const records = Object.values(table);
  return Promise.all(records.map(async (r) => {
    try {
      const g = await chrome.tabGroups.get(r.groupId);
      const tabs = await chrome.tabs.query({ groupId: r.groupId });
      return {
        ...r,
        color: g.color,
        windowId: g.windowId,
        tabCount: tabs.length,
        collapsed: g.collapsed,
        alive: true
      };
    } catch {
      return { ...r, tabCount: 0, alive: false };
    }
  }));
}

export async function closeTabGroup(name: string): Promise<{ closed: boolean; groupExisted: boolean; ungroupedTabs: number }> {
  const table = await loadTable();
  const rec = table[name];
  if (!rec) {
    throw new Error(`Tab-group "${name}" not found.`);
  }
  let groupExisted = false;
  let ungrouped = 0;
  try {
    const tabs = await chrome.tabs.query({ groupId: rec.groupId });
    const ids = tabs.map((t) => t.id).filter((id): id is number => typeof id === "number");
    if (ids.length > 0) {
      await chrome.tabs.ungroup(ids);
      ungrouped = ids.length;
    }
    groupExisted = true;
  } catch {
    // Group already gone — treat the close as successful (name is freed).
  }
  delete table[name];
  await saveTable(table);
  return { closed: true, groupExisted, ungroupedTabs: ungrouped };
}

export async function addToTabGroup(name: string, tabIds: number[]): Promise<{ groupId: number; added: number }> {
  const table = await loadTable();
  const rec = table[name];
  if (!rec) {
    throw new Error(`Tab-group "${name}" not found. Run: chrome-relay group create ${name} --tabs <ids> first.`);
  }
  if (tabIds.length === 0) {
    throw new Error("addToTabGroup requires at least one tabId.");
  }
  await chrome.tabs.group({ tabIds, groupId: rec.groupId });
  return { groupId: rec.groupId, added: tabIds.length };
}

export async function removeFromTabGroup(tabIds: number[]): Promise<{ removed: number }> {
  if (tabIds.length === 0) {
    throw new Error("removeFromTabGroup requires at least one tabId.");
  }
  await chrome.tabs.ungroup(tabIds);
  return { removed: tabIds.length };
}

// resolveTabGroupTarget: pick a tab for `--group X` to operate on. Returns
// the active tab in the group if any are active; otherwise the first tab.
// Throws if the group is unknown or empty.
export async function resolveTabGroupTarget(name: string): Promise<chrome.tabs.Tab> {
  const table = await loadTable();
  const rec = table[name];
  if (!rec) {
    throw new Error(`Tab-group "${name}" not found. Run: chrome-relay group create ${name} --tabs <ids>`);
  }
  try {
    await chrome.tabGroups.get(rec.groupId);
  } catch {
    throw new Error(
      `Tab-group "${name}" (id ${rec.groupId}) is gone (window closed, or you ungrouped its last tab). ` +
        `Run: chrome-relay group close ${name} && chrome-relay group create ${name} --tabs <ids>`
    );
  }
  const tabs = await chrome.tabs.query({ groupId: rec.groupId });
  if (tabs.length === 0) {
    throw new Error(`Tab-group "${name}" has no tabs.`);
  }
  const active = tabs.find((t) => t.active);
  return active ?? tabs[0];
}

// Auto-prune: when a tab-group disappears (last tab moved out, or window
// closed), drop our record so the table doesn't carry zombies. Failures
// here are non-fatal — a future `group list` will surface the orphan.
chrome.tabGroups.onRemoved.addListener(async (group) => {
  try {
    const table = await loadTable();
    let changed = false;
    for (const [name, rec] of Object.entries(table)) {
      if (rec.groupId === group.id) {
        delete table[name];
        changed = true;
      }
    }
    if (changed) await saveTable(table);
  } catch {
    // SW teardown — non-fatal.
  }
});
