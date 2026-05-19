// Workspaces — named handles for Chrome WINDOWS so multiple agents (autark
// hypotheses, parallel test runs) can drive separate windows without fighting
// over the same active tab.
//
// Pre-0.4.0 these were called "groups." That collided with Chrome's own
// tab-group UI primitive (the colored, collapsible folder inside one window),
// which is now exposed separately via tab-groups.ts. Same isolation story,
// clearer vocabulary.
//
// Hard lifecycle (per oversight doc): if the user manually closes the
// window, the workspace is orphaned. The next op against `--workspace X`
// fails loudly with "window gone, run workspace close OR workspace create
// to recover." Easier-to-reason-about than soft-rebinding behind the
// agent's back.

import { RelayError, TOOL_NAMES } from "@chrome-relay/protocol";

const STORAGE_KEY = "chrome_relay_workspaces_v1";

export interface WorkspaceRecord {
  name: string;          // user-chosen identifier (e.g. "bidsmith-h01")
  windowId: number;      // chrome.windows id
  createdAt: number;     // Date.now() at create
  label?: string;        // optional human description shown in popup
}

interface WorkspaceTable {
  [name: string]: WorkspaceRecord;
}

async function loadTable(): Promise<WorkspaceTable> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as WorkspaceTable) || {};
}

async function saveTable(table: WorkspaceTable): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: table });
}

export async function createWorkspace(name: string, opts: { url?: string; label?: string } = {}): Promise<WorkspaceRecord> {
  if (!name || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(name)) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `Workspace name must match [a-z0-9][a-z0-9_.-]{0,63}. Got: "${name}"`,
      tool: TOOL_NAMES.WORKSPACE,
      phase: "validate_workspace_name",
      details: { name },
      retryable: false
    });
  }
  const table = await loadTable();
  if (table[name]) {
    // If the existing window is still alive, refuse — caller should `workspace close` first.
    try {
      await chrome.windows.get(table[name].windowId);
      throw new RelayError({
        code: "invalid_arguments",
        message: `Workspace "${name}" already exists (window ${table[name].windowId}). Run: chrome-relay workspace close ${name} first.`,
        tool: TOOL_NAMES.WORKSPACE,
        phase: "create_workspace",
        details: { name, windowId: table[name].windowId, reason: "name_in_use" },
        retryable: false
      });
    } catch (e) {
      // Window is gone — silently overwrite the orphan record below.
      if (e instanceof RelayError) throw e;
    }
  }
  const window = await chrome.windows.create({
    url: opts.url ?? "about:blank",
    focused: false,
    type: "normal"
  });
  if (typeof window.id !== "number") {
    throw new RelayError({
      code: "chrome_api_error",
      message: "chrome.windows.create did not return a window id.",
      tool: TOOL_NAMES.WORKSPACE,
      phase: "chrome.windows.create",
      details: { returnedWindow: window },
      retryable: false
    });
  }
  const record: WorkspaceRecord = {
    name,
    windowId: window.id,
    createdAt: Date.now(),
    label: opts.label
  };
  table[name] = record;
  await saveTable(table);
  return record;
}

export async function listWorkspaces(): Promise<Array<WorkspaceRecord & { tabCount: number; alive: boolean }>> {
  const table = await loadTable();
  const records = Object.values(table);
  const decorated = await Promise.all(records.map(async (w) => {
    try {
      const win = await chrome.windows.get(w.windowId, { populate: true });
      return { ...w, tabCount: win.tabs?.length ?? 0, alive: true };
    } catch {
      return { ...w, tabCount: 0, alive: false };
    }
  }));
  return decorated;
}

export async function closeWorkspace(name: string): Promise<{ closed: boolean; windowExisted: boolean }> {
  const table = await loadTable();
  const rec = table[name];
  if (!rec) {
    throw new RelayError({
      code: "target_not_found",
      message: `Workspace "${name}" not found.`,
      tool: TOOL_NAMES.WORKSPACE,
      phase: "close_workspace",
      details: { name },
      retryable: false
    });
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

// resolveWorkspaceTarget: find the "active tab in the workspace's window."
// Throws loudly if the window is gone (Hard lifecycle).
export async function resolveWorkspaceTarget(name: string): Promise<chrome.tabs.Tab> {
  const table = await loadTable();
  const rec = table[name];
  if (!rec) {
    throw new RelayError({
      code: "target_not_found",
      message: `Workspace "${name}" not found. Run: chrome-relay workspace create ${name}`,
      tool: TOOL_NAMES.WORKSPACE,
      phase: "resolve_workspace",
      details: { name },
      retryable: false
    });
  }
  let windowId: number;
  try {
    const win = await chrome.windows.get(rec.windowId);
    windowId = win.id as number;
  } catch (e) {
    throw new RelayError({
      code: "target_not_found",
      message:
        `Workspace "${name}"'s window (id ${rec.windowId}) is gone. ` +
        `Run: chrome-relay workspace close ${name} && chrome-relay workspace create ${name}`,
      tool: TOOL_NAMES.WORKSPACE,
      phase: "chrome.windows.get",
      details: { name, windowId: rec.windowId, underlying: e instanceof Error ? e.message : String(e) },
      retryable: false
    });
  }
  const tabs = await chrome.tabs.query({ active: true, windowId });
  if (tabs.length === 0 || !tabs[0]) {
    throw new RelayError({
      code: "target_not_found",
      message: `Workspace "${name}"'s window has no active tab.`,
      tool: TOOL_NAMES.WORKSPACE,
      phase: "chrome.tabs.query",
      details: { name, windowId, active: true },
      retryable: false
    });
  }
  return tabs[0];
}

// Auto-prune orphaned records when the user manually closes a workspace's
// window. We don't want the records table filling up with dead entries
// silently — when the window goes, the record goes. Failures here are
// non-fatal: a future `workspace list` will surface the orphan anyway.
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
