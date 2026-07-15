// chrome_upload handler — action=set and action=drop unit coverage over a
// method-routed CDP mock. action=choose's full chooser choreography needs a
// real Chrome (covered by the e2e fixtures); its argument/lock rules are
// exercised where they don't need events.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RelayError } from "@chrome-relay/protocol";
import { getChromeStub } from "./setup-chrome-mock";

const sendMock = vi.fn();

vi.mock("../src/browser/cdp", () => ({
  send: (...args: unknown[]) => sendMock(...args),
  ensureAttached: vi.fn().mockResolvedValue(undefined),
  evalExpression: vi.fn(),
  evalInTab: vi.fn()
}));
// target.ts pulls these in; their module-level listeners touch chrome APIs
// the stub doesn't model (tabGroups/windows onRemoved). Same pattern as
// handler-strict.test.ts.
vi.mock("../src/browser/tab-groups", () => ({
  resolveTabGroupTarget: vi.fn(),
  createTabGroup: vi.fn(),
  listTabGroups: vi.fn(),
  closeTabGroup: vi.fn(),
  addToTabGroup: vi.fn(),
  removeFromTabGroup: vi.fn()
}));
vi.mock("../src/browser/workspaces", () => ({
  resolveWorkspaceTarget: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  closeWorkspace: vi.fn()
}));

type MethodRoutes = Record<string, unknown | ((params: Record<string, unknown>) => unknown)>;

function routeSend(routes: MethodRoutes): void {
  sendMock.mockImplementation(async (_tabId: unknown, method: unknown, params: unknown) => {
    const route = routes[method as string];
    if (route === undefined) return {};
    return typeof route === "function"
      ? (route as (p: Record<string, unknown>) => unknown)(params as Record<string, unknown>)
      : route;
  });
}

const FILE_INPUT_ROUTES: MethodRoutes = {
  "DOM.getDocument": { root: { nodeId: 1 } },
  "DOM.querySelector": { nodeId: 2 },
  "DOM.describeNode": {
    node: { nodeName: "INPUT", attributes: ["type", "file", "accept", ".pdf"], backendNodeId: 77 }
  },
  "DOM.setFileInputFiles": {},
  "DOM.resolveNode": { object: { objectId: "obj-1" } },
  "Runtime.callFunctionOn": {
    result: { value: [{ name: "cv.pdf", size: 4821, type: "application/pdf" }] }
  }
};

async function loadHandler() {
  const mod = await import("../src/browser/handlers/upload");
  const handler = mod.uploadHandlers["chrome_upload"];
  if (!handler) throw new Error("upload handler not registered");
  return handler;
}

async function relayCode(fn: () => Promise<unknown>): Promise<RelayError> {
  try {
    await fn();
  } catch (e) {
    // Duck-type, not instanceof: vi.resetModules() gives the handler its own
    // copy of the protocol module, so class identity doesn't cross.
    if ((e as Error)?.name === "RelayError") return e as RelayError;
    throw e;
  }
  throw new Error("expected a RelayError");
}

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  delete (globalThis as { chrome?: { extension?: unknown } }).chrome?.extension;
  getChromeStub().tabs.get.mockResolvedValue({ id: 5 });
});

describe("chrome_upload action=set", () => {
  it("sets files on a file input by selector and returns the VERIFIED holdings", async () => {
    routeSend(FILE_INPUT_ROUTES);
    const handler = await loadHandler();
    const result = (await handler({
      action: "set",
      selector: "input[type=file]",
      tabId: 5,
      files: ["/tmp/cv.pdf"]
    })) as Record<string, unknown>;

    const setCall = sendMock.mock.calls.find((c) => c[1] === "DOM.setFileInputFiles");
    expect(setCall?.[2]).toEqual({ files: ["/tmp/cv.pdf"], backendNodeId: 77 });
    expect(result.files).toEqual([{ name: "cv.pdf", size: 4821, type: "application/pdf" }]);
    expect(result.input).toEqual({ multiple: false, accept: ".pdf" });
  });

  it("fails not_a_file_input on a non-input target", async () => {
    routeSend({
      ...FILE_INPUT_ROUTES,
      "DOM.describeNode": { node: { nodeName: "DIV", attributes: [], backendNodeId: 78 } }
    });
    const handler = await loadHandler();
    const err = await relayCode(() =>
      handler({ action: "set", selector: ".styled-button", tabId: 5, files: ["/tmp/cv.pdf"] })
    );
    expect(err.code).toBe("not_a_file_input");
    expect(err.message).toContain("action=choose");
  });

  it("fails multiple_not_supported when two files hit a single-file input", async () => {
    routeSend(FILE_INPUT_ROUTES); // attributes carry no `multiple`
    const handler = await loadHandler();
    const err = await relayCode(() =>
      handler({ action: "set", selector: "input", tabId: 5, files: ["/a.pdf", "/b.pdf"] })
    );
    expect(err.code).toBe("multiple_not_supported");
    const setCall = sendMock.mock.calls.find((c) => c[1] === "DOM.setFileInputFiles");
    expect(setCall).toBeUndefined(); // hard fail BEFORE touching the input
  });

  it("allows two files when the input has `multiple`", async () => {
    routeSend({
      ...FILE_INPUT_ROUTES,
      "DOM.describeNode": {
        node: { nodeName: "INPUT", attributes: ["type", "file", "multiple", ""], backendNodeId: 77 }
      }
    });
    const handler = await loadHandler();
    const result = (await handler({
      action: "set",
      selector: "input",
      tabId: 5,
      files: ["/a.pdf", "/b.pdf"]
    })) as Record<string, unknown>;
    expect((result.input as Record<string, unknown>).multiple).toBe(true);
  });

  it("flags accept mismatches as warnings in the data — never a failure", async () => {
    routeSend(FILE_INPUT_ROUTES); // accept=".pdf"
    const handler = await loadHandler();
    const result = (await handler({
      action: "set",
      selector: "input",
      tabId: 5,
      files: ["/tmp/avatar.png"]
    })) as Record<string, unknown>;
    expect(result.warnings).toEqual([{ code: "accept_mismatch", file: "/tmp/avatar.png", accept: ".pdf" }]);
    expect(result.files).toBeDefined(); // the set still happened
  });

  it("fails element_not_found when the selector matches nothing", async () => {
    routeSend({ ...FILE_INPUT_ROUTES, "DOM.querySelector": { nodeId: 0 } });
    const handler = await loadHandler();
    const err = await relayCode(() =>
      handler({ action: "set", selector: "#missing", tabId: 5, files: ["/tmp/cv.pdf"] })
    );
    expect(err.code).toBe("element_not_found");
  });
});

describe("file-access gate (all actions)", () => {
  it('fails file_access_denied with remediation when "Allow access to file URLs" is off', async () => {
    (globalThis as any).chrome.extension = {
      isAllowedFileSchemeAccess: (cb: (allowed: boolean) => void) => cb(false)
    };
    routeSend(FILE_INPUT_ROUTES);
    const handler = await loadHandler();
    const err = await relayCode(() =>
      handler({ action: "set", selector: "input", tabId: 5, files: ["/tmp/cv.pdf"] })
    );
    expect(err.code).toBe("file_access_denied");
    expect(err.message).toContain("chrome://extensions");
    expect(sendMock).not.toHaveBeenCalled(); // gated before any CDP traffic
  });

  it("proceeds when the API is unavailable (unknown ≠ denied)", async () => {
    routeSend(FILE_INPUT_ROUTES);
    const handler = await loadHandler();
    const result = await handler({ action: "set", selector: "input", tabId: 5, files: ["/tmp/cv.pdf"] });
    expect(result).toBeDefined();
  });
});

describe("chrome_upload action=drop", () => {
  it("dispatches dragEnter → dragOver → drop with path-based DragData.files", async () => {
    routeSend({
      ...FILE_INPUT_ROUTES,
      "DOM.describeNode": { node: { nodeName: "DIV", attributes: [], backendNodeId: 90 } },
      "DOM.getBoxModel": { model: { content: [0, 0, 100, 0, 100, 50, 0, 50] } },
      "Runtime.evaluate": (params: Record<string, unknown>) =>
        String(params.expression).includes("__chromeRelayDropHandled")
          ? { result: { value: true } }
          : { result: {} },
      "Input.dispatchDragEvent": {}
    });
    const handler = await loadHandler();
    const result = (await handler({
      action: "drop",
      selector: ".dropzone",
      tabId: 5,
      files: ["/tmp/avatar.png"]
    })) as Record<string, unknown>;

    const dragCalls = sendMock.mock.calls.filter((c) => c[1] === "Input.dispatchDragEvent");
    expect(dragCalls.map((c) => (c[2] as { type: string }).type)).toEqual(["dragEnter", "dragOver", "drop"]);
    for (const call of dragCalls) {
      const params = call[2] as { x: number; y: number; data: { files: string[] } };
      expect(params.data.files).toEqual(["/tmp/avatar.png"]);
      expect(params.x).toBe(50);
      expect(params.y).toBe(25);
    }
    expect(result.dispatched).toBe(true);
    expect(result.dropHandled).toBe(true);
  });
});

describe("chrome_upload argument strictness (parser at the handler boundary)", () => {
  it("rejects a choose call with set-style targeting", async () => {
    const handler = await loadHandler();
    const err = await relayCode(() =>
      handler({ action: "choose", ref: "e1", files: ["/tmp/cv.pdf"] })
    );
    expect(err.code).toBe("invalid_arguments");
  });

  it("rejects empty files", async () => {
    const handler = await loadHandler();
    const err = await relayCode(() => handler({ action: "set", ref: "e1", files: [] }));
    expect(err.code).toBe("invalid_arguments");
  });
});
