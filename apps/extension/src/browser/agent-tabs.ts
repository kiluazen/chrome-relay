// Tabs an agent opens with `navigate --new` go into an "Agent" tab group in
// their window, so the person can see at a glance which tabs are being
// driven and keep their own work out of them. One group per window, reused
// while it lives. Best effort: grouping never fails the navigate.

export const AGENT_GROUP_TITLE = "Agent";

// windowId → groupId of the Agent group we made there.
const groups = new Map<number, number>();

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

export async function groupAgentTab(tab: chrome.tabs.Tab): Promise<number | undefined> {
  if (typeof tab.id !== "number" || typeof tab.windowId !== "number") return undefined;
  try {
    const existing = await liveGroup(tab.windowId);
    if (existing !== undefined) {
      await chrome.tabs.group({ groupId: existing, tabIds: [tab.id] });
      return existing;
    }
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: "grey" });
    groups.set(tab.windowId, groupId);
    return groupId;
  } catch {
    return undefined;
  }
}
