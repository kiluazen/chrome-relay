// Tabs an agent opens with `navigate --new` go into an "Agent" tab group in
// their window, so the person can see at a glance which tabs are being
// driven and keep their own work out of them. One group per window, reused
// while it lives. Best effort: grouping never fails the navigate.
//
// Opera (tab islands) dissolves any group with fewer than two tabs the
// moment it is created, so a lone agent tab can't start the group there.
// That tab is remembered and the group starts when the next agent tab in
// the same window arrives.

export const AGENT_GROUP_TITLE = "Agent";

// windowId → groupId of the Agent group we made there.
const groups = new Map<number, number>();
// windowId → an agent tab whose group was dissolved on creation.
const waiting = new Map<number, number>();

async function liveGroup(windowId: number): Promise<number | undefined> {
  const known = groups.get(windowId);
  if (known !== undefined) {
    try {
      const g = await chrome.tabGroups.get(known);
      if (g.windowId === windowId) return known;
    } catch {
      /* closed */
    }
    groups.delete(windowId);
  }
  // After a service-worker restart the map is empty; find it by title.
  try {
    const [found] = await chrome.tabGroups.query({ windowId, title: AGENT_GROUP_TITLE });
    if (found) {
      groups.set(windowId, found.id);
      return found.id;
    }
  } catch {
    /* tabGroups unavailable */
  }
  return undefined;
}

// The waiting tab, if it is still open, still in this window and still
// outside any group (the person may have moved it).
async function waitingTab(windowId: number): Promise<number | undefined> {
  const id = waiting.get(windowId);
  if (id === undefined) return undefined;
  try {
    const t = await chrome.tabs.get(id);
    if (t.windowId === windowId && t.groupId === -1) return id;
  } catch {
    /* closed */
  }
  waiting.delete(windowId);
  return undefined;
}

export async function groupAgentTab(tab: chrome.tabs.Tab): Promise<number | undefined> {
  if (typeof tab.id !== "number" || typeof tab.windowId !== "number") return undefined;
  try {
    const existing = await liveGroup(tab.windowId);
    if (existing !== undefined) {
      await chrome.tabs.group({ groupId: existing, tabIds: [tab.id] });
      return existing;
    }
    const partner = await waitingTab(tab.windowId);
    const tabIds = partner === undefined ? [tab.id] : [partner, tab.id];
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: tab.windowId } });
    try {
      await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: "grey" });
    } catch {
      // Dissolved on creation: wait for the next agent tab.
      waiting.set(tab.windowId, tab.id);
      return undefined;
    }
    waiting.delete(tab.windowId);
    groups.set(tab.windowId, groupId);
    return groupId;
  } catch {
    return undefined;
  }
}
