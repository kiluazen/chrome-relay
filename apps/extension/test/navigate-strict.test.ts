// @vitest-environment jsdom
//
// Code-quality-hardening PR 3: chrome_navigate no longer silently falls
// back to "wherever Chrome picks" when an explicit routing intent fails.
// Tests cover the two cases the doc named:
//
//   1. --new --tab <id> where <id> doesn't exist → was silently swallowed,
//      now throws RelayError(target_not_found).
//   2. --new --group <name> where joining the group fails → was silently
//      swallowed, now throws RelayError(partial_success_disallowed). The
//      tab IS created (we don't roll back) so the agent can clean up.
//
// Both behaviors are opt-out via allowPartial:true (returns a warning shape
// instead of throwing).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RelayError } from "@chrome-relay/protocol";

// Module-level mocks for the helpers navigate calls — keeps the test
// scoped to the handler's strict-fallback rules without exercising the
// real tab-groups / workspaces / cdp paths.
vi.mock("../src/browser/tab-groups", () => ({
  createTabGroup: vi.fn(),
  listTabGroups: vi.fn(),
  closeTabGroup: vi.fn(),
  addToTabGroup: vi.fn(),
  removeFromTabGroup: vi.fn(),
  resolveTabGroupTarget: vi.fn(async () => ({ tabId: 100, windowId: 9 }))
}));
vi.mock("../src/browser/workspaces", () => ({
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  closeWorkspace: vi.fn(),
  resolveWorkspaceTarget: vi.fn(async () => ({ tabId: 100, windowId: 9 }))
}));
vi.mock("../src/browser/cdp", () => ({
  ensureAttached: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
  evalExpression: vi.fn(),
  evalInTab: vi.fn()
}));
// Stub the buffer modules so importing tools.ts doesn't try to wire CDP
// event listeners against an undefined chrome global. We don't exercise
// them in this file.
vi.mock("../src/browser/console-buffer", () => ({
  ensureConsoleCapture: vi.fn(),
  readConsole: vi.fn(),
  clearConsole: vi.fn()
}));
vi.mock("../src/browser/network-buffer", () => ({
  ensureNetworkCapture: vi.fn(),
  readNetwork: vi.fn(),
  clearNetwork: vi.fn(),
  buildHar: vi.fn(),
  getBody: vi.fn()
}));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).chrome = {
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() }
    },
    tabs: {
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      onRemoved: { addListener: vi.fn() }
    },
    windows: {
      update: vi.fn(),
      getAll: vi.fn().mockResolvedValue([])
    }
  };
});

async function load() {
  const tools = await import("../src/browser/tools");
  return tools.runTool;
}

describe("chrome_navigate --new --tab <id> strict behavior", () => {
  it("throws target_not_found when the reference tab doesn't exist", async () => {
    (globalThis as any).chrome.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 999"));
    const runTool = await load();

    let caught: unknown;
    try {
      await runTool("chrome_navigate", { url: "https://example.com", newTab: true, tabId: 999 });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RelayError);
    const err = caught as RelayError;
    expect(err.code).toBe("target_not_found");
    expect(err.tool).toBe("chrome_navigate");
    expect(err.phase).toBe("resolve_reference_tab");
    expect(err.details?.tabId).toBe(999);
    // Importantly: we never even called chrome.tabs.create — refusal happens
    // before the new tab is opened.
    expect((globalThis as any).chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("with allowPartial:true, falls back to Chrome-picks-window (no throw)", async () => {
    (globalThis as any).chrome.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 999"));
    (globalThis as any).chrome.tabs.create.mockResolvedValueOnce({ id: 12345, windowId: 1, url: "https://example.com" });
    const runTool = await load();

    const result = await runTool("chrome_navigate", {
      url: "https://example.com",
      newTab: true,
      tabId: 999,
      allowPartial: true
    });

    expect(result).toMatchObject({ tabId: 12345 });
    // chrome.tabs.create was called without windowId (Chrome picks).
    const createCall = (globalThis as any).chrome.tabs.create.mock.calls[0][0];
    expect(createCall).not.toHaveProperty("windowId");
  });

  it("rejects an invalid (non-numeric) tabId with invalid_arguments", async () => {
    const runTool = await load();
    let caught: unknown;
    try {
      await runTool("chrome_navigate", { url: "https://example.com", newTab: true, tabId: "not-a-num" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RelayError);
    expect((caught as RelayError).code).toBe("invalid_arguments");
  });
});

describe("chrome_navigate --new --group <name> strict join behavior", () => {
  it("throws partial_success_disallowed when group-join fails (tab still created)", async () => {
    (globalThis as any).chrome.tabs.create.mockResolvedValueOnce({ id: 67890, windowId: 9, url: "https://example.com" });
    const { addToTabGroup } = await import("../src/browser/tab-groups");
    (addToTabGroup as any).mockRejectedValueOnce(new Error("Group disappeared mid-flight"));
    const runTool = await load();

    let caught: unknown;
    try {
      await runTool("chrome_navigate", {
        url: "https://example.com",
        newTab: true,
        groupName: "research"
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RelayError);
    const err = caught as RelayError;
    expect(err.code).toBe("partial_success_disallowed");
    expect(err.phase).toBe("join_tab_group");
    expect(err.details?.createdTabId).toBe(67890);
    expect(err.details?.groupName).toBe("research");
    // Tab WAS created (we don't roll back; the agent can call close_tabs).
    expect((globalThis as any).chrome.tabs.create).toHaveBeenCalled();
  });

  it("with allowPartial:true, returns success with warnings[] instead of throwing", async () => {
    (globalThis as any).chrome.tabs.create.mockResolvedValueOnce({ id: 67890, windowId: 9, url: "https://example.com" });
    const { addToTabGroup } = await import("../src/browser/tab-groups");
    (addToTabGroup as any).mockRejectedValueOnce(new Error("Group disappeared"));
    const runTool = await load();

    const result = await runTool("chrome_navigate", {
      url: "https://example.com",
      newTab: true,
      groupName: "research",
      allowPartial: true
    }) as Record<string, unknown>;

    expect(result.tabId).toBe(67890);
    expect(result.partial).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    const warnings = result.warnings as Array<{ code: string; message: string }>;
    expect(warnings[0].code).toBe("group_join_failed");
  });
});
