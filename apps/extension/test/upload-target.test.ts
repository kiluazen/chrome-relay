import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ click: vi.fn(), send: vi.fn() }));
vi.mock("../src/browser/cdp", () => ({ send: mocks.send }));
vi.mock("../src/browser/identity", () => ({ getFileSchemeAccess: vi.fn(async () => true) }));
vi.mock("../src/browser/element", () => ({ resolveRefCenter: vi.fn(), resolveRefTarget: vi.fn() }));
vi.mock("../src/browser/handlers/target", () => ({ resolveTarget: vi.fn(async () => ({ id: 41 })), requireTabId: (tab: { id: number }) => tab.id }));
vi.mock("../src/browser/handlers/input", () => ({ inputHandlers: { chrome_click_element: mocks.click } }));
import { uploadHandlers } from "../src/browser/handlers/upload";

describe("upload chooser target", () => {
  it.each([{}, { workspaceName: "research" }, { groupName: "research" }])("pins the armed tab despite dynamic scope %j", async (scope) => {
    const listeners: ((source: { tabId: number }, method: string, params: unknown) => void)[] = [];
    const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
    const debuggerEvent = { addListener: (fn: typeof listeners[number]) => listeners.push(fn), removeListener: vi.fn() };
    (globalThis as any).chrome = { debugger: { onEvent: debuggerEvent }, tabs: { onRemoved: event(), onUpdated: event() } };
    mocks.send.mockImplementation(async (_tab: number, method: string) => {
      if (method === "DOM.describeNode") return { node: { nodeName: "INPUT", backendNodeId: 77, attributes: ["type", "file"] } };
      if (method === "DOM.resolveNode") return { object: { objectId: "input" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: [] } };
      return {};
    });
    mocks.click.mockImplementation(async (args) => {
      // Simulate the user's active tab becoming 99 after interception was
      // armed. A dynamic click would now go there and open its OS dialog.
      const target = args.tabId ?? 99;
      for (const fn of listeners) fn({ tabId: target }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
      expect(args).toEqual({ selector: "#upload", tabId: 41 });
    });
    const result = await uploadHandlers.chrome_upload!({ action: "choose", clickSelector: "#upload", files: ["/tmp/cv.pdf"], timeoutMs: 5, ...scope });
    expect(result).toMatchObject({ tabId: 41 });
    expect(mocks.send.mock.calls.filter(c => c[1] === "Page.setInterceptFileChooserDialog").map(c => c[0])).toEqual([41, 41]);
    mocks.send.mockClear();
  });
});

it("keeps the chooser guard until interception has finished disarming", async () => {
  const listeners: ((source: { tabId: number }, method: string, params: unknown) => void)[] = [];
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  (globalThis as any).chrome = { debugger: { onEvent: { addListener: (fn: typeof listeners[number]) => listeners.push(fn), removeListener: vi.fn() } }, tabs: { onRemoved: event(), onUpdated: event() } };
  let release!: () => void;
  let disarmStarted!: () => void;
  const started = new Promise<void>(r => { disarmStarted = r; });
  const blocked = new Promise<void>(r => { release = r; });
  mocks.send.mockImplementation(async (_tab: number, method: string, args: { enabled?: boolean }) => {
    if (method === "Page.setInterceptFileChooserDialog" && args.enabled === false) { disarmStarted(); await blocked; }
    if (method === "DOM.describeNode") return { node: { nodeName: "INPUT", backendNodeId: 77, attributes: ["type", "file"] } };
    if (method === "DOM.resolveNode") return { object: { objectId: "input" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: [] } };
    return {};
  });
  mocks.click.mockImplementation(async () => {
    for (const fn of listeners) fn({ tabId: 41 }, "Page.fileChooserOpened", { backendNodeId: 77, mode: "selectSingle" });
  });
  const args = { action: "choose", clickSelector: "#upload", files: ["/tmp/cv.pdf"], timeoutMs: 5 };
  const first = uploadHandlers.chrome_upload!(args);
  await started;
  try {
    await expect(uploadHandlers.chrome_upload!(args)).rejects.toMatchObject({ code: "file_chooser_busy" });
  } finally { release(); await first; }
});
