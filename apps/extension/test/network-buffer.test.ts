// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

let listenerSpy: ReturnType<typeof vi.fn>;
let sendMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  listenerSpy = vi.fn();
  sendMock = vi.fn().mockResolvedValue(undefined);
  (globalThis as any).chrome = {
    debugger: { onEvent: { addListener: listenerSpy } },
    tabs:     { onRemoved: { addListener: vi.fn() } }
  };
  vi.doMock("../src/browser/cdp", () => ({
    ensureAttached: vi.fn().mockResolvedValue(undefined),
    send: sendMock
  }));
});

async function load() {
  return await import("../src/browser/network-buffer");
}

function dispatch(tabId: number, method: string, params: Record<string, unknown>) {
  const fn = listenerSpy.mock.calls[0][0] as (s: any, m: string, p: any) => void;
  fn({ tabId }, method, params);
}

describe("network-buffer", () => {
  it("read on a fresh tab returns empty", async () => {
    const m = await load();
    expect(m.readNetwork(1)).toEqual({ entries: [], total: 0 });
  });

  it("captures full request → response → finished lifecycle", async () => {
    const m = await load();
    await m.ensureNetworkCapture(1);
    dispatch(1, "Network.requestWillBeSent", {
      requestId: "req-1",
      request: { url: "https://api.example.com/users", method: "GET", headers: { "user-agent": "test" } },
      timestamp: 100,
      wallTime: 1700000000
    });
    dispatch(1, "Network.responseReceived", {
      requestId: "req-1",
      response: {
        url: "https://api.example.com/users",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        mimeType: "application/json"
      }
    });
    dispatch(1, "Network.loadingFinished", {
      requestId: "req-1",
      timestamp: 100.5,
      encodedDataLength: 12345
    });

    const { entries } = m.readNetwork(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "req-1",
      url: "https://api.example.com/users",
      method: "GET",
      status: 200,
      mimeType: "application/json",
      encodedBodySize: 12345
    });
    expect(entries[0].finishedAt).toBeDefined();
  });

  it("captures failed requests with errorText", async () => {
    const m = await load();
    await m.ensureNetworkCapture(2);
    dispatch(2, "Network.requestWillBeSent", {
      requestId: "req-fail",
      request: { url: "https://nope.invalid/", method: "GET" },
      timestamp: 0,
      wallTime: 1700
    });
    dispatch(2, "Network.loadingFailed", {
      requestId: "req-fail",
      timestamp: 1,
      errorText: "net::ERR_NAME_NOT_RESOLVED",
      canceled: false
    });
    const { entries } = m.readNetwork(2);
    expect(entries[0].failed).toEqual({ errorText: "net::ERR_NAME_NOT_RESOLVED", canceled: false });
  });

  it("url substring filter narrows", async () => {
    const m = await load();
    await m.ensureNetworkCapture(3);
    for (const url of ["https://api.example.com/a", "https://cdn.example.com/b", "https://api.example.com/c"]) {
      dispatch(3, "Network.requestWillBeSent", {
        requestId: url,
        request: { url, method: "GET" },
        timestamp: 0,
        wallTime: 0
      });
    }
    const { entries } = m.readNetwork(3, { filter: "api." });
    expect(entries.map((e) => e.url)).toEqual([
      "https://api.example.com/a",
      "https://api.example.com/c"
    ]);
  });

  it("status bucket filter splits 200 vs 404 vs failed", async () => {
    const m = await load();
    await m.ensureNetworkCapture(4);
    function go(id: string, status?: number) {
      dispatch(4, "Network.requestWillBeSent", {
        requestId: id, request: { url: `https://x/${id}`, method: "GET" }, timestamp: 0, wallTime: 0
      });
      if (typeof status === "number") {
        dispatch(4, "Network.responseReceived", {
          requestId: id, response: { url: `https://x/${id}`, status, statusText: "", headers: {} }
        });
      }
    }
    go("a", 200);
    go("b", 404);
    go("c", 500);
    dispatch(4, "Network.requestWillBeSent", { requestId: "d", request: { url: "https://x/d", method: "GET" }, timestamp: 0, wallTime: 0 });
    dispatch(4, "Network.loadingFailed", { requestId: "d", timestamp: 1, errorText: "ERR", canceled: false });

    expect(m.readNetwork(4, { status: "ok" }).entries.map((e) => e.id)).toEqual(["a"]);
    expect(m.readNetwork(4, { status: "client_error" }).entries.map((e) => e.id)).toEqual(["b"]);
    expect(m.readNetwork(4, { status: "server_error" }).entries.map((e) => e.id)).toEqual(["c"]);
    expect(m.readNetwork(4, { status: "failed" }).entries.map((e) => e.id)).toEqual(["d"]);
  });

  it("method filter is case-insensitive on input, uppercase-matched", async () => {
    const m = await load();
    await m.ensureNetworkCapture(5);
    dispatch(5, "Network.requestWillBeSent", { requestId: "g", request: { url: "https://x/g", method: "GET"  }, timestamp: 0, wallTime: 0 });
    dispatch(5, "Network.requestWillBeSent", { requestId: "p", request: { url: "https://x/p", method: "POST" }, timestamp: 0, wallTime: 0 });
    expect(m.readNetwork(5, { method: "post" }).entries.map((e) => e.id)).toEqual(["p"]);
  });

  it("clear empties the buffer", async () => {
    const m = await load();
    await m.ensureNetworkCapture(6);
    dispatch(6, "Network.requestWillBeSent", { requestId: "x", request: { url: "https://x", method: "GET" }, timestamp: 0, wallTime: 0 });
    expect(m.readNetwork(6).entries).toHaveLength(1);
    expect(m.clearNetwork(6)).toEqual({ cleared: 1 });
    expect(m.readNetwork(6).entries).toHaveLength(0);
  });

  it("ring caps at 200 entries — oldest dropped", async () => {
    const m = await load();
    await m.ensureNetworkCapture(7);
    for (let i = 0; i < 250; i++) {
      dispatch(7, "Network.requestWillBeSent", {
        requestId: `r${i}`, request: { url: `https://x/${i}`, method: "GET" }, timestamp: 0, wallTime: 0
      });
    }
    const { entries } = m.readNetwork(7);
    expect(entries.length).toBe(200);
    expect(entries[0].id).toBe("r50");
    expect(entries[199].id).toBe("r249");
  });

  it("buildHar emits log.entries with request + response + timings", async () => {
    const m = await load();
    await m.ensureNetworkCapture(8);
    dispatch(8, "Network.requestWillBeSent", {
      requestId: "req-har",
      request: { url: "https://x.com/y", method: "POST", headers: { "x-foo": "bar" } },
      timestamp: 0,
      wallTime: 1700000000
    });
    dispatch(8, "Network.responseReceived", {
      requestId: "req-har",
      response: {
        url: "https://x.com/y",
        status: 201,
        statusText: "Created",
        headers: { "content-type": "application/json" },
        mimeType: "application/json"
      }
    });
    // buildHar is async now (withBodies pre-fetch path); always await.
    const har = (await m.buildHar(8)) as { log: { entries: Array<{ request: any; response: any; timings: any; _chrome_relay: any }> } };
    expect(har.log.entries).toHaveLength(1);
    const e = har.log.entries[0];
    expect(e.request).toMatchObject({ method: "POST", url: "https://x.com/y" });
    expect(e.request.headers).toContainEqual({ name: "x-foo", value: "bar" });
    expect(e.response).toMatchObject({ status: 201, statusText: "Created" });
    expect(e._chrome_relay.requestId).toBe("req-har");
  });

  it("getBody throws clearly when the request isn't in the buffer", async () => {
    const m = await load();
    await m.ensureNetworkCapture(9);
    await expect(m.getBody(9, "unknown-req")).rejects.toThrow(/not in this tab's network buffer/);
  });

  it("getBody throws a descriptive error when CDP says body is gone", async () => {
    const m = await load();
    await m.ensureNetworkCapture(10);
    dispatch(10, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://x", method: "GET" }, timestamp: 0, wallTime: 0 });
    sendMock.mockImplementationOnce(async (_t: number, method: string) => {
      if (method === "Network.enable") return undefined;
      throw new Error("ignored");
    });
    // The Network.getResponseBody call is the next send() — make it throw.
    sendMock.mockImplementation(async (_t: number, method: string) => {
      if (method === "Network.getResponseBody") throw new Error("body no longer available");
      return undefined;
    });
    await expect(m.getBody(10, "r1")).rejects.toThrow(/no longer available/);
  });
});
