// Groups — named handles for Chrome windows so multiple agents (autark
// hypotheses, parallel test runs) can drive separate windows without
// fighting over the same active tab.
//
// Hard lifecycle (per oversight doc): if the user manually closes the
// window, the group is orphaned. The next op against `--group X` fails
// loudly with "window gone, run group close OR group create to recover."
// Easier-to-reason-about than soft-rebinding behind the agent's back.

const STORAGE_KEY = "chrome_relay_groups_v1";

export interface GroupRecord {
  name: string;          // user-chosen identifier (e.g. "bidsmith-h01")
  windowId: number;      // chrome.windows id
  createdAt: number;     // Date.now() at create
  label?: string;        // optional human description shown in popup
}

interface GroupTable {
  [name: string]: GroupRecord;
}

async function loadTable(): Promise<GroupTable> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as GroupTable) || {};
}

async function saveTable(table: GroupTable): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: table });
}

export async function createGroup(name: string, opts: { url?: string; label?: string } = {}): Promise<GroupRecord> {
  if (!name || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(name)) {
    throw new Error(`Group name must match [a-z0-9][a-z0-9_.-]{0,63}. Got: "${name}"`);
  }
  const table = await loadTable();
  if (table[name]) {
    // If the existing window is still alive, refuse — caller should `group close` first.
    try {
      await chrome.windows.get(table[name].windowId);
      throw new Error(`Group "${name}" already exists (window ${table[name].windowId}). Run: chrome-relay group close ${name} first.`);
    } catch (e) {
      // Window is gone — silently overwrite the orphan record below.
      if (e instanceof Error && /already exists/.test(e.message)) throw e;
    }
  }
  const window = await chrome.windows.create({
    url: opts.url ?? "about:blank",
    focused: false,
    type: "normal"
  });
  if (typeof window.id !== "number") {
    throw new Error("chrome.windows.create did not return a window id.");
  }
  const record: GroupRecord = {
    name,
    windowId: window.id,
    createdAt: Date.now(),
    label: opts.label
  };
  table[name] = record;
  await saveTable(table);
  return record;
}

export async function listGroups(): Promise<Array<GroupRecord & { tabCount: number; alive: boolean }>> {
  const table = await loadTable();
  const records = Object.values(table);
  const decorated = await Promise.all(records.map(async (g) => {
    try {
      const win = await chrome.windows.get(g.windowId, { populate: true });
      return { ...g, tabCount: win.tabs?.length ?? 0, alive: true };
    } catch {
      return { ...g, tabCount: 0, alive: false };
    }
  }));
  return decorated;
}

export async function closeGroup(name: string): Promise<{ closed: boolean; windowExisted: boolean }> {
  const table = await loadTable();
  const rec = table[name];
  if (!rec) {
    throw new Error(`Group "${name}" not found.`);
  }
  let windowExisted = false;
  try {
    await chrome.windows.remove(rec.windowId);
    windowExisted = true;
  } catch {
    // Window already gone — orphan record. Still counts as a successful close
    // (the user wanted the name freed; it's freed).
  }
  delete table[name];
  await saveTable(table);
  return { closed: true, windowExisted };
}

// resolveGroupTarget: find the "active tab in the group's window."
// Throws loudly if the window is gone (Hard lifecycle).
export async function resolveGroupTarget(name: string): Promise<chrome.tabs.Tab> {
  const table = await loadTable();
  const rec = table[name];
  if (!rec) {
    throw new Error(
      `Group "${name}" not found. Run: chrome-relay group create ${name}`
    );
  }
  let windowId: number;
  try {
    const win = await chrome.windows.get(rec.windowId);
    windowId = win.id as number;
  } catch {
    throw new Error(
      `Group "${name}"'s window (id ${rec.windowId}) is gone. ` +
        `Run: chrome-relay group close ${name} && chrome-relay group create ${name}`
    );
  }
  const tabs = await chrome.tabs.query({ active: true, windowId });
  if (tabs.length === 0 || !tabs[0]) {
    throw new Error(`Group "${name}"'s window has no active tab.`);
  }
  return tabs[0];
}

// Auto-prune orphaned records when the user manually closes a group's window.
// We don't want the records.json filling up with dead entries silently — when
// the window goes, the record goes. Failures here are non-fatal: a future
// `group list` will surface the orphan anyway.
chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    const table = await loadTable();
    let changed = false;
    for (const [name, rec] of Object.entries(table)) {
      if (rec.windowId === windowId) {
        delete table[name];
        changed = true;
      }
    }
    if (changed) await saveTable(table);
  } catch {
    // Storage may be unavailable during SW teardown — non-fatal.
  }
});
