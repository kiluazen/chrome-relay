// @vitest-environment jsdom
//
// Code-quality-hardening PR 10: structured errors on the rest of the
// extension handlers. Tests cover:
//   - resolveTarget rejects conflicting loose target fields with target_conflict
//   - missing-arg throws now produce RelayError(invalid_arguments) instead of
//     plain Error (so agents can branch on err.code).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RelayError } from "@chrome-relay/protocol";

// Mock the downstream modules so we can exercise the handler-level error
// paths without exercising real chrome.* APIs.
vi.mock("../src/browser/cdp", () => ({
  ensureAttached: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
  evalExpression: vi.fn(),
  evalInTab: vi.fn()
}));
vi.mock("../src/browser/tab-groups", () => ({
  createTabGroup: vi.fn(),
  listTabGroups: vi.fn(),
  closeTabGroup: vi.fn(),
  addToTabGroup: vi.fn(),
  removeFromTabGroup: vi.fn(),
  resolveTabGroupTarget: vi.fn(async () => ({ id: 100, windowId: 9 }))
}));
vi.mock("../src/browser/workspaces", () => ({
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  closeWorkspace: vi.fn(),
  resolveWorkspaceTarget: vi.fn(async () => ({ id: 100, windowId: 9 }))
}));
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
    debugger: { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(), onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
    tabs: { get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), query: vi.fn(async () => [{ id: 99, windowId: 9 }]), onRemoved: { addListener: vi.fn() } },
    windows: { update: vi.fn(), getAll: vi.fn().mockResolvedValue([]) }
  };
});

async function load() {
  const tools = await import("../src/browser/tools");
  return tools.runTool;
}

async function expectRelayError(fn: () => Promise<unknown>, code: string): Promise<RelayError> {
  let caught: unknown;
  try { await fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(RelayError);
  const err = caught as RelayError;
  expect(err.code).toBe(code);
  return err;
}

describe("resolveTarget — strict against conflicting loose target fields", () => {
  it("rejects tabId + workspaceName with target_conflict", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_read_page", { tabId: 1, workspaceName: "research" }),
      "target_conflict"
    );
    expect(err.details?.received).toEqual(["tabId", "workspaceName"]);
  });

  it("rejects tabId + groupName with target_conflict", async () => {
    const runTool = await load();
    await expectRelayError(
      () => runTool("chrome_read_page", { tabId: 1, groupName: "deep" }),
      "target_conflict"
    );
  });

  it("rejects workspaceName + groupName with target_conflict", async () => {
    const runTool = await load();
    await expectRelayError(
      () => runTool("chrome_read_page", { workspaceName: "ws", groupName: "g" }),
      "target_conflict"
    );
  });

  it("rejects all three with target_conflict", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_read_page", { tabId: 1, workspaceName: "ws", groupName: "g" }),
      "target_conflict"
    );
    expect(err.details?.received).toEqual(["tabId", "groupName", "workspaceName"]);
  });
});

describe("resolveTarget — structured target misses", () => {
  it("returns target_not_found when the active tab cannot be resolved", async () => {
    (globalThis as any).chrome.tabs.query.mockResolvedValueOnce([]);
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_read_page", {}),
      "target_not_found"
    );
    expect(err.phase).toBe("resolve_active_tab");
  });

  it("returns target_not_found when an explicit tab id is stale", async () => {
    (globalThis as any).chrome.tabs.get.mockRejectedValueOnce(new Error("No tab with id: 123"));
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_read_page", { tabId: 123 }),
      "target_not_found"
    );
    expect(err.phase).toBe("resolve_tab");
    expect(err.details?.tabId).toBe(123);
  });
});

describe("Missing-arg throws now structured invalid_arguments", () => {
  it("chrome_click_element without selector → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_click_element", {}),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_click_element");
  });

  it("chrome_keyboard without keys → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_keyboard", {}),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_keyboard");
  });

  it("chrome_type without text → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_type", {}),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_type");
  });

  it("chrome_evaluate without code → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_evaluate", {}),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_evaluate");
  });

  it("chrome_switch_tab without numeric tabId → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_switch_tab", { tabId: "not-a-num" }),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_switch_tab");
  });

  it("chrome_close_tabs without numeric tabIds → invalid_arguments", async () => {
    const runTool = await load();
    await expectRelayError(
      () => runTool("chrome_close_tabs", { tabIds: ["foo"] }),
      "invalid_arguments"
    );
  });

  it("chrome_workspace create without name → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_workspace", { action: "create" }),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_workspace");
  });

  it("chrome_group create without name → invalid_arguments", async () => {
    const runTool = await load();
    await expectRelayError(
      () => runTool("chrome_group", { action: "create" }),
      "invalid_arguments"
    );
  });

  it("chrome_network body without requestId → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_network", { action: "body" }),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_network");
  });

  it("chrome_viewport set without numeric width/height → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_viewport", { action: "set", width: "wide", height: "tall" }),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_viewport");
  });

  it("chrome_viewport preset with unknown name → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_viewport", { action: "preset", name: "futurephone-99" }),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_viewport");
    expect(err.details?.received).toBe("futurephone-99");
    expect(Array.isArray(err.details?.validChoices)).toBe(true);
  });

  it("chrome_hover without selector/x/y → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_hover", {}),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_hover");
  });

  it("chrome_click_ax without --node → invalid_arguments", async () => {
    const runTool = await load();
    const err = await expectRelayError(
      () => runTool("chrome_click_ax", {}),
      "invalid_arguments"
    );
    expect(err.tool).toBe("chrome_click_ax");
  });
});
