// Control handlers: RELEASE, STATUS
//
// The person's view of, and exit from, what the agent holds. See cdp.ts for
// leases (attach on use, detach when idle, pins, quiet) and human.ts for
// agent input waiting on the person.

import { parseChromeReleaseArgs, parseChromeStatusArgs, TOOL_NAMES } from "@chrome-relay/protocol";
import { IDLE_DETACH_MS, listLeases, releaseAll, releaseTab } from "../cdp";
import { humanIdleMs } from "../human";
import { resolveTarget, requireTabId, type ToolHandler } from "./target";

// Popup: how many tabs are held, and its Release button.
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "chrome-relay.leases") {
      sendResponse({ count: listLeases().length });
    } else if (message?.type === "chrome-relay.release-all") {
      void releaseAll().then((released) => sendResponse({ released }), () => sendResponse({ released: [] }));
      return true;
    }
  });
}

export const controlHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.RELEASE](args) {
    const parsed = parseChromeReleaseArgs(args);
    if (parsed.all) {
      return { released: await releaseAll() };
    }
    const tabId = requireTabId(await resolveTarget(parsed));
    return { released: (await releaseTab(tabId)) ? [tabId] : [] };
  },

  async [TOOL_NAMES.STATUS](args) {
    parseChromeStatusArgs(args);
    const leases = listLeases();
    const tabs = await Promise.all(
      leases.map(async (l) => {
        const tab = await chrome.tabs.get(l.tabId).catch(() => undefined);
        const userIdle = humanIdleMs(l.tabId);
        return {
          ...l,
          ...(tab ? { title: tab.title, url: tab.url, active: tab.active } : {}),
          ...(userIdle !== null ? { userIdleMs: userIdle } : {})
        };
      })
    );
    return { idleDetachMs: IDLE_DETACH_MS, attachedCount: tabs.length, tabs };
  }
};
