// Navigation readiness: a tab with a pending navigation (tab.pendingUrl) is
// never "ready", even though its initial about:blank document already says
// readyState "complete". That gap used to let `navigate --new` → `wait
// --load` → `snapshot` read an empty page on every non-local site.

import { describe, it, expect, vi, beforeEach } from "vitest";

const evalExpression = vi.fn();
const send = vi.fn();
vi.mock("../src/browser/cdp", () => ({
  ensureAttached: vi.fn().mockResolvedValue(undefined),
  send: (...a: unknown[]) => send(...a),
  evalExpression: (...a: unknown[]) => evalExpression(...a),
  evalInTab: vi.fn()
}));
vi.mock("../src/browser/tab-groups", () => ({ addToTabGroup: vi.fn(), resolveTabGroupTarget: vi.fn() }));
vi.mock("../src/browser/workspaces", () => ({ resolveWorkspaceTarget: vi.fn() }));
vi.mock("../src/browser/element", () => ({ resolveRefTarget: vi.fn() }));
vi.mock("../src/browser/console-buffer", () => ({ ensureConsoleCapture: vi.fn(), readConsole: vi.fn(), clearConsole: vi.fn() }));
vi.mock("../src/browser/network-buffer", () => ({
  ensureNetworkCapture: vi.fn(), readNetwork: vi.fn(), clearNetwork: vi.fn(), buildHar: vi.fn(), getBody: vi.fn()
}));

// A scripted tab timeline: each tabs.get / readyState probe advances it.
type Phase = { pendingUrl?: string; url: string; status: string; readyState: string; href?: string };
let timeline: Phase[];
let step: number;
const current = () => timeline[Math.min(step, timeline.length - 1)];

beforeEach(() => {
  vi.clearAllMocks();
  step = 0;
  timeline = [];
  (globalThis as any).chrome = {
    debugger: {
      attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(),
      onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() }
    },
    runtime: { id: "test", onMessage: { addListener: vi.fn() } },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn() }, session: { get: vi.fn(async () => ({})), set: vi.fn() } },
    tabs: {
      get: vi.fn(async (id: number) => {
        const p = current();
        step += 1;
        return { id, windowId: 1, url: p.url, status: p.status, ...(p.pendingUrl ? { pendingUrl: p.pendingUrl } : {}) };
      }),
      create: vi.fn(async () => ({ id: 7, windowId: 1, url: "", pendingUrl: "https://example.com/" })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() }
    }
  };
  evalExpression.mockImplementation(async (_tabId: number, expr: string) => {
    const p = current();
    if (expr.includes("performance")) return { value: { rs: p.readyState, n: 1 } };
    if (expr.includes("location.href")) return { value: { rs: p.readyState, href: p.href ?? p.url } };
    return { value: expr.includes('"complete"') ? p.readyState === "complete" : p.readyState !== "loading" };
  });
});

const blankPending: Phase = { pendingUrl: "https://example.com/", url: "", status: "loading", readyState: "complete", href: "about:blank" };
const parsing: Phase = { url: "https://example.com/", status: "loading", readyState: "loading" };
const interactive: Phase = { url: "https://example.com/", status: "loading", readyState: "interactive" };
const loaded: Phase = { url: "https://example.com/", status: "complete", readyState: "complete" };

describe("waitForDocument", () => {
  it("does not accept the initial about:blank while a navigation is pending", async () => {
    timeline = [blankPending, blankPending, blankPending, parsing, interactive];
    const { waitForDocument } = await import("../src/browser/readiness");
    const r = await waitForDocument(7, "domcontentloaded", 5_000);
    expect(r).toMatchObject({ ready: true, url: "https://example.com/", readyState: "interactive" });
  });

  it("load needs readyState complete AND tab status complete", async () => {
    timeline = [interactive, { ...loaded, status: "loading" }, loaded];
    const { waitForDocument } = await import("../src/browser/readiness");
    const r = await waitForDocument(7, "load", 5_000);
    expect(r).toMatchObject({ ready: true, readyState: "complete" });
  });

  it("reports a slow page as not ready instead of throwing", async () => {
    timeline = [blankPending];
    const { waitForDocument } = await import("../src/browser/readiness");
    const r = await waitForDocument(7, "domcontentloaded", 60);
    expect(r.ready).toBe(false);
    expect(r.url).toBe("https://example.com/");
  });

  it("flags Chrome's network error page", async () => {
    timeline = [{ ...loaded, href: "chrome-error://chromewebdata/" }];
    const { waitForDocument } = await import("../src/browser/readiness");
    expect(await waitForDocument(7, "load", 1_000)).toMatchObject({ ready: true, errorPage: true });
  });

  it("treats an un-attachable page (chrome://) as loaded once Chrome says complete", async () => {
    timeline = [{ url: "chrome://extensions/", status: "complete", readyState: "complete" }];
    evalExpression.mockRejectedValue(new Error("Cannot access a chrome:// URL"));
    const { waitForDocument } = await import("../src/browser/readiness");
    expect(await waitForDocument(7, "load", 1_000)).toMatchObject({ ready: true });
  });
});

describe("chrome_navigate waitUntil", () => {
  it("new tab: returns once the real document is interactive, with readiness fields", async () => {
    timeline = [blankPending, blankPending, parsing, interactive];
    const { runTool } = await import("../src/browser/tools");
    const r = (await runTool("chrome_navigate", {
      url: "https://example.com/",
      newTab: true,
      waitUntil: "domcontentloaded"
    })) as Record<string, unknown>;
    expect(r).toMatchObject({ tabId: 7, url: "https://example.com/", ready: true, readyState: "interactive" });
    expect(typeof r.waitedMs).toBe("number");
  });

  it("omitted waitUntil keeps the old immediate return (no readiness probes)", async () => {
    const { runTool } = await import("../src/browser/tools");
    const r = (await runTool("chrome_navigate", { url: "https://example.com/", newTab: true })) as Record<string, unknown>;
    expect(r).toEqual({ tabId: 7, windowId: 1, url: "https://example.com/" });
    expect(evalExpression).not.toHaveBeenCalled();
  });

  it("existing tab: surfaces Page.navigate's errorText as loadFailed", async () => {
    timeline = [{ ...loaded, href: "chrome-error://chromewebdata/" }];
    send.mockResolvedValueOnce({ errorText: "net::ERR_NAME_NOT_RESOLVED" });
    const { runTool } = await import("../src/browser/tools");
    const r = await runTool("chrome_navigate", { url: "https://nope.invalid/", tabId: 7, waitUntil: "load" });
    expect(r).toMatchObject({ loadFailed: true, errorText: "net::ERR_NAME_NOT_RESOLVED" });
  });

  it("rejects an unknown waitUntil before touching Chrome", async () => {
    const { runTool } = await import("../src/browser/tools");
    await expect(runTool("chrome_navigate", { url: "https://example.com/", newTab: true, waitUntil: "idle" }))
      .rejects.toMatchObject({ code: "invalid_arguments" });
    expect((globalThis as any).chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe("chrome_wait --load", () => {
  it("is not satisfied by about:blank while the navigation is pending", async () => {
    timeline = [blankPending, blankPending, blankPending, blankPending, blankPending, loaded];
    const { runTool } = await import("../src/browser/tools");
    const r = (await runTool("chrome_wait", { tabId: 7, load: "load", timeoutMs: 5_000 })) as { satisfied: boolean; waitedMs: number };
    expect(r.satisfied).toBe(true);
    // Every probe before the commit answered "not yet".
    expect(r.waitedMs).toBeGreaterThan(0);
  });
});
