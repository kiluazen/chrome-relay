// Shared target-resolution helpers used by every domain handler module.
// Lives here (rather than in tools.ts) so the per-domain handler files
// don't form a cycle with the dispatcher.

import { RelayError, type ToolArguments } from "@chrome-relay/protocol";
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

// Target-tab resolver. Exactly one of {tabId, groupName, workspaceName} may
// be set per call. If more than one arrives here (from a third-party caller
// posting directly to /call), we throw target_conflict — same rule the CLI
// already enforces upstream (code-quality-hardening PR 2).
//
// Precedence when zero are set: active tab in current window.
export async function resolveTarget(args: {
  tabId?: unknown;
  groupName?: unknown;
  workspaceName?: unknown;
}): Promise<chrome.tabs.Tab> {
  const present: string[] = [];
  if (typeof args.tabId === "number") present.push("tabId");
  if (typeof args.groupName === "string" && args.groupName) present.push("groupName");
  if (typeof args.workspaceName === "string" && args.workspaceName) present.push("workspaceName");
  if (present.length > 1) {
    throw new RelayError({
      code: "target_conflict",
      message: `Target conflict: ${present.join(" + ")} are mutually exclusive. Pass exactly one of tabId, groupName, or workspaceName.`,
      phase: "resolve_target",
      details: { received: present },
      retryable: false
    });
  }
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

// Helper: throw a typed invalid_arguments error from a handler. Wrapping
// the most common pattern (missing required field) so each call site stays
// a one-liner. The agent gets `code: "invalid_arguments"`, `tool`, `phase`,
// and the human-readable message.
import type { ToolName } from "@chrome-relay/protocol";
export function invalidArg(
  tool: ToolName,
  message: string,
  phase = "parse_arguments",
  details?: Record<string, unknown>
): never {
  throw new RelayError({
    code: "invalid_arguments",
    message,
    tool,
    phase,
    details,
    retryable: false
  });
}
