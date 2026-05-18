// Tab lifecycle + navigation handlers:
//   GET_WINDOWS_AND_TABS, NAVIGATE, SWITCH_TAB, CLOSE_TABS

import { RelayError, TOOL_NAMES } from "@chrome-relay/protocol";
import { send } from "../cdp";
import { addToTabGroup, resolveTabGroupTarget } from "../tab-groups";
import { resolveWorkspaceTarget } from "../workspaces";
import { resolveTarget, requireTabId, invalidArg, type ToolHandler } from "./target";

export const navigationHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.GET_WINDOWS_AND_TABS]() {
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
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) {
      throw new RelayError({
        code: "invalid_arguments",
        message: "chrome_navigate requires a url.",
        tool: TOOL_NAMES.NAVIGATE,
        phase: "parse_arguments",
        retryable: false
      });
    }

    const newTab = args.newTab === true;
    const active = args.active !== false;
    // Opt-in flag: when true, restores the pre-0.5.5 silent best-effort
    // behavior for windowId resolution + group-join — failures degrade
    // to "tab landed somewhere, group not joined" instead of erroring.
    const allowPartial = args.allowPartial === true;

    if (newTab) {
      const createOpts: chrome.tabs.CreateProperties = { url, active };
      let joinTabGroupName: string | undefined;
      if (typeof args.tabId === "number" || typeof args.tabId === "string") {
        const numeric = Number(args.tabId);
        if (!Number.isFinite(numeric)) {
          throw new RelayError({
            code: "invalid_arguments",
            message: `chrome_navigate: invalid tabId ${JSON.stringify(args.tabId)}. Expected a number.`,
            tool: TOOL_NAMES.NAVIGATE,
            phase: "resolve_reference_tab",
            details: { received: args.tabId },
            retryable: false
          });
        }
        try {
          const ref = await chrome.tabs.get(numeric);
          if (typeof ref.windowId === "number") createOpts.windowId = ref.windowId;
        } catch (e) {
          if (!allowPartial) {
            throw new RelayError({
              code: "target_not_found",
              message: `chrome_navigate: reference tab ${numeric} not found; refusing to silently route to a different window. Re-run with allowPartial: true to let Chrome pick.`,
              tool: TOOL_NAMES.NAVIGATE,
              phase: "resolve_reference_tab",
              details: { tabId: numeric, underlying: e instanceof Error ? e.message : String(e) },
              retryable: false
            });
          }
        }
      } else if (typeof args.groupName === "string" && args.groupName) {
        const groupTab = await resolveTabGroupTarget(args.groupName);
        if (typeof groupTab.windowId === "number") createOpts.windowId = groupTab.windowId;
        joinTabGroupName = args.groupName;
      } else if (typeof args.workspaceName === "string" && args.workspaceName) {
        const wsTab = await resolveWorkspaceTarget(args.workspaceName);
        if (typeof wsTab.windowId === "number") createOpts.windowId = wsTab.windowId;
      }
      const tab = await chrome.tabs.create(createOpts);
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
      const result: Record<string, unknown> = { tabId: tab.id, windowId: tab.windowId, url: tab.url };
      if (warnings.length > 0) {
        result.partial = true;
        result.warnings = warnings;
      }
      return result;
    }

    const current = await resolveTarget(args);
    const tabId = requireTabId(current);

    await send(tabId, "Page.navigate", { url });
    if (active) {
      await chrome.tabs.update(tabId, { active: true });
    }

    return { tabId, windowId: current.windowId, url };
  },

  async [TOOL_NAMES.SWITCH_TAB](args) {
    const tabId = Number(args.tabId);
    if (!Number.isFinite(tabId)) {
      invalidArg(TOOL_NAMES.SWITCH_TAB, "chrome_switch_tab requires a numeric tabId.", "parse_arguments", { received: args.tabId });
    }

    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
    return { tabId: tab.id, windowId: tab.windowId, active: true };
  },

  async [TOOL_NAMES.CLOSE_TABS](args) {
    const tabIds = Array.isArray(args.tabIds) ? args.tabIds.map((value) => Number(value)) : [];
    if (tabIds.length === 0 || tabIds.some((value) => !Number.isFinite(value))) {
      invalidArg(TOOL_NAMES.CLOSE_TABS, "chrome_close_tabs requires a numeric tabIds array.", "parse_arguments", { received: args.tabIds });
    }

    await chrome.tabs.remove(tabIds);
    return { closedTabIds: tabIds };
  }
};
