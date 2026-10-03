// Tab lifecycle + navigation handlers:
//   GET_WINDOWS_AND_TABS, NAVIGATE, SWITCH_TAB, CLOSE_TABS

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  parseChromeCloseTabsArgs,
  parseChromeNavigateArgs,
  parseChromeSwitchTabArgs,
  parseGetWindowsAndTabsArgs,
  RelayError,
  TOOL_NAMES,
  type ChromeNavigateArgs
} from "@chrome-relay/protocol";
import { ensureAttached, send } from "../cdp";
import { waitForDocument } from "../readiness";
import { addToTabGroup, resolveTabGroupTarget } from "../tab-groups";
import { resolveWorkspaceTarget } from "../workspaces";
import { resolveTarget, requireTabId, type ToolHandler } from "./target";

// waitUntil support: report readiness on the navigate result itself, so the
// agent's next command (snapshot, click) reads the page it asked for.
// Slowness is reported (ready:false), never thrown — the tab exists and
// the navigation is under way; the caller decides what to do next.
async function settle(
  tabId: number,
  parsed: ChromeNavigateArgs,
  errorText?: string
): Promise<Record<string, unknown>> {
  const level = parsed.waitUntil;
  if (!level || level === "none") return errorText ? { loadFailed: true, errorText } : {};
  const r = await waitForDocument(tabId, level, parsed.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  return {
    url: r.url,
    ready: r.ready,
    ...(r.readyState ? { readyState: r.readyState } : {}),
    waitedMs: r.waitedMs,
    ...(errorText || r.errorPage ? { loadFailed: true, ...(errorText ? { errorText } : {}) } : {})
  };
}

export const navigationHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.GET_WINDOWS_AND_TABS](args) {
    parseGetWindowsAndTabsArgs(args);
    const windows = await chrome.windows.getAll({ populate: true });
    return {
      windowCount: windows.length,
      tabCount: windows.reduce((count, current) => count + (current.tabs?.length ?? 0), 0),
      windows: windows.map((window) => ({
        windowId: window.id,
        focused: window.focused,
        tabs: (window.tabs ?? []).map((tab) => ({
          tabId: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          active: tab.active
        }))
      }))
    };
  },

  async [TOOL_NAMES.NAVIGATE](args) {
    const parsed = parseChromeNavigateArgs(args);
    const { url } = parsed;
    const newTab = parsed.newTab === true;
    const allowPartial = parsed.allowPartial === true;

    if (newTab) {
      const createOpts: chrome.tabs.CreateProperties = { url, active: false };
      let joinTabGroupName: string | undefined;
      if (parsed.tabId !== undefined) {
        try {
          const ref = await chrome.tabs.get(parsed.tabId);
          if (typeof ref.windowId === "number") createOpts.windowId = ref.windowId;
        } catch (e) {
          if (!allowPartial) {
            throw new RelayError({
              code: "target_not_found",
              message: `chrome_navigate: reference tab ${parsed.tabId} not found; refusing to silently route to a different window. Re-run with allowPartial: true to let Chrome pick.`,
              tool: TOOL_NAMES.NAVIGATE,
              phase: "resolve_reference_tab",
              details: { tabId: parsed.tabId, underlying: e instanceof Error ? e.message : String(e) },
              retryable: false
            });
          }
        }
      } else if (parsed.groupName) {
        const groupTab = await resolveTabGroupTarget(parsed.groupName);
        if (typeof groupTab.windowId === "number") createOpts.windowId = groupTab.windowId;
        joinTabGroupName = parsed.groupName;
      } else if (parsed.workspaceName) {
        const wsTab = await resolveWorkspaceTarget(parsed.workspaceName);
        if (typeof wsTab.windowId === "number") createOpts.windowId = wsTab.windowId;
      }
      const tab = await chrome.tabs.create(createOpts);
      // Attach while the first navigation is still in flight so the
      // visibility shim (cdp.ts) is registered before the page's own
      // scripts run; best effort — settle() attaches on demand anyway.
      if (parsed.waitUntil && parsed.waitUntil !== "none" && typeof tab.id === "number") {
        await ensureAttached(tab.id).catch(() => {});
      }
      const warnings: Array<{ code: string; message: string }> = [];
      if (joinTabGroupName && typeof tab.id === "number") {
        try {
          await addToTabGroup(joinTabGroupName, [tab.id]);
        } catch (e) {
          if (!allowPartial) {
            throw new RelayError({
              code: "partial_success_disallowed",
              message: `chrome_navigate: created tab ${tab.id} but failed to add it to group ${joinTabGroupName}. Pass allowPartial: true to keep the tab and emit a warning instead.`,
              tool: TOOL_NAMES.NAVIGATE,
              phase: "join_tab_group",
              details: {
                createdTabId: tab.id,
                groupName: joinTabGroupName,
                underlying: e instanceof Error ? e.message : String(e)
              },
              retryable: false
            });
          }
          warnings.push({
            code: "group_join_failed",
            message: `Tab ${tab.id} was created but could not be added to group ${joinTabGroupName}.`
          });
        }
      }
      const result: Record<string, unknown> = {
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.pendingUrl ?? tab.url,
        ...(typeof tab.id === "number" ? await settle(tab.id, parsed) : {})
      };
      if (warnings.length > 0) {
        result.partial = true;
        result.warnings = warnings;
      }
      return result;
    }

    const current = await resolveTarget(parsed);
    const tabId = requireTabId(current);

    const nav = await send<{ errorText?: string }>(tabId, "Page.navigate", { url });

    return { tabId, windowId: current.windowId, url, ...(await settle(tabId, parsed, nav?.errorText || undefined)) };
  },

  async [TOOL_NAMES.SWITCH_TAB](args) {
    // Legacy command: validate, then reject in the shared parser before
    // touching Chrome. The CLI uses the same gate, including raw calls.
    parseChromeSwitchTabArgs(args);
  },

  async [TOOL_NAMES.CLOSE_TABS](args) {
    const { tabIds } = parseChromeCloseTabsArgs(args);
    await chrome.tabs.remove(tabIds);
    return { closedTabIds: tabIds };
  }
};
