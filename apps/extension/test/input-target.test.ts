import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ activeTab: 41 }));
vi.mock("../src/browser/handlers/target", () => ({
  resolveTarget: vi.fn(async () => ({ id: state.activeTab, url: "https://example.com" })),
  requireTabId: (tab: { id: number }) => tab.id
}));
vi.mock("../src/browser/cdp", () => ({
  send: vi.fn(async () => { state.activeTab = 99; return {}; }),
  evalExpression: vi.fn(),
  evalInTab: vi.fn(async () => { state.activeTab = 99; return { x: 1, y: 2, filled: true }; })
}));
vi.mock("../src/browser/element", () => ({ resolveRefCenter: vi.fn(), resolveRefObjectId: vi.fn(), mapPageError: vi.fn() }));
vi.mock("../src/browser/keyboard", () => ({ pressKey: vi.fn(async () => { state.activeTab = 99; }) }));
vi.mock("../src/browser/settle", () => ({ armSettle: vi.fn() }));
vi.mock("../src/browser/cursor", () => ({ moveCursor: vi.fn(), pulseCursor: vi.fn() }));
import { inputHandlers } from "../src/browser/handlers/input";

beforeEach(() => { state.activeTab = 41; });
describe("action result pins the tab before a user's active-tab change", () => {
  it.each([
    ["chrome_click_element", { selector: "#go", waitForNavigation: false }],
    ["chrome_click_element", { x: 1, y: 2, waitForNavigation: false }],
    ["chrome_fill_or_select", { selector: "#q", value: "hello" }],
    ["chrome_type", { text: "hello", selector: "#q" }],
    ["chrome_keyboard", { keys: "Enter" }]
  ])("%s reports the acted tab for the follow-up snapshot", async (tool, args) => {
    const result = await inputHandlers[tool]!(args);
    expect(state.activeTab).toBe(99);
    expect(result).toMatchObject({ tabId: 41 });
  });
});
