// Shared target-resolution helpers used by every domain handler module.
// Lives here (rather than in tools.ts) so the per-domain handler files
// don't form a cycle with the dispatcher.

import type { ToolArguments } from "@chrome-relay/protocol";
import { resolveTabGroupTarget } from "../tab-groups";
import { resolveWorkspaceTarget } from "../workspaces";

export type ToolHandler = (args: ToolArguments) => Promise<unknown>;

export async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

// Target-tab resolver. Precedence (most → least specific):
//   1. explicit tabId — `--tab N` wins over everything else
//   2. groupName     — `--group X` picks the active tab inside tab-group X
//   3. workspaceName — `--workspace W` picks the active tab inside window W
//   4. active tab in current window — no flag given
//
// The CLI already enforces single-selector-per-scope (PR 2). When more
// than one arrives here it's a third-party caller posting directly to
// /call; precedence applies silently to preserve back-compat.
export async function resolveTarget(args: {
  tabId?: unknown;
  groupName?: unknown;
  workspaceName?: unknown;
}): Promise<chrome.tabs.Tab> {
  if (typeof args.tabId === "number") {
    return chrome.tabs.get(args.tabId);
  }
  if (typeof args.groupName === "string" && args.groupName) {
    return resolveTabGroupTarget(args.groupName);
  }
  if (typeof args.workspaceName === "string" && args.workspaceName) {
    return resolveWorkspaceTarget(args.workspaceName);
  }
  return getActiveTab();
}

// Compatibility shim — existing call sites still pass a bare number.
export async function getTargetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (typeof tabId === "number") {
    return chrome.tabs.get(tabId);
  }
  return getActiveTab();
}

export function requireTabId(tab: chrome.tabs.Tab): number {
  if (typeof tab.id !== "number") {
    throw new Error("Target tab has no tab ID.");
  }
  return tab.id;
}
