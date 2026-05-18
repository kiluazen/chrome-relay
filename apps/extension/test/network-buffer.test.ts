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

  // Regression for issues.md #3 (fixed in 0.3.3): the --with-bodies path was
  // fetching response bodies correctly via Network.getResponseBody, but the
  // entry-merge step read the wrong field name (`text` instead of `body`)
  // and silently dropped the payload. HAR entries came out with no `text`
  // even when bodies were on disk. This test pins the field plumbing so the
  // typo can't come back.
  it("buildHar(withBodies=true) writes the fetched body into entry.response.content.text", async () => {
    const m = await load();
    await m.ensureNetworkCapture(11);
    dispatch(11, "Network.requestWillBeSent", {
      requestId: "req-body",
      request: { url: "https://x.com/y", method: "GET" },
      timestamp: 0,
      wallTime: 1700000000
    });
    dispatch(11, "Network.responseReceived", {
      requestId: "req-body",
      response: { url: "https://x.com/y", status: 200, statusText: "OK", headers: {}, mimeType: "text/plain" }
    });
    dispatch(11, "Network.loadingFinished", { requestId: "req-body", timestamp: 0.5, encodedDataLength: 11 });

    // Stub Network.getResponseBody so we don't need a real CDP session.
    sendMock.mockImplementation(async (_t: number, method: string) => {
      if (method === "Network.getResponseBody") return { body: "hello world", base64Encoded: false };
      return undefined;
    });

    const har = (await m.buildHar(11, {}, true)) as {
      log: { entries: Array<{ response: { content: { text?: string; encoding?: string; size: number; mimeType: string } } }> }
    };
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].response.content.text).toBe("hello world");
    expect(har.log.entries[0].response.content.encoding).toBeUndefined();
  });

  it("buildHar(withBodies=true) propagates base64Encoded as content.encoding", async () => {
    const m = await load();
    await m.ensureNetworkCapture(12);
    dispatch(12, "Network.requestWillBeSent", {
      requestId: "req-img",
      request: { url: "https://x.com/i.png", method: "GET" },
      timestamp: 0,
      wallTime: 1700000000
    });
    dispatch(12, "Network.responseReceived", {
      requestId: "req-img",
      response: { url: "https://x.com/i.png", status: 200, statusText: "OK", headers: {}, mimeType: "image/png" }
    });
    dispatch(12, "Network.loadingFinished", { requestId: "req-img", timestamp: 0.5, encodedDataLength: 8 });

    sendMock.mockImplementation(async (_t: number, method: string) => {
      if (method === "Network.getResponseBody") return { body: "iVBORw0K", base64Encoded: true };
      return undefined;
    });

    const har = (await m.buildHar(12, {}, true)) as {
      log: { entries: Array<{ response: { content: { text?: string; encoding?: string } } }> }
    };
    expect(har.log.entries[0].response.content.text).toBe("iVBORw0K");
    expect(har.log.entries[0].response.content.encoding).toBe("base64");
  });

  // PR 4 of code-quality-hardening: HAR body transparency.
  // Strict by default — withBodies fails when any body can't be fetched.
  // bestEffortBodies:true restores the legacy permissive behavior.
  it("buildHar(withBodies=true) throws partial_success_disallowed when bodies fail", async () => {
    const m = await load();
    const { RelayError } = await import("@chrome-relay/protocol");
    await m.ensureNetworkCapture(20);
    dispatch(20, "Network.requestWillBeSent", {
      requestId: "req-gc",
      request: { url: "https://x.com/gone", method: "GET" },
      timestamp: 0, wallTime: 1700000000
    });
    dispatch(20, "Network.responseReceived", {
      requestId: "req-gc",
      response: { url: "https://x.com/gone", status: 200, statusText: "OK", headers: {}, mimeType: "text/plain" }
    });
    dispatch(20, "Network.loadingFinished", { requestId: "req-gc", timestamp: 0.5, encodedDataLength: 5 });

    // Simulate Chrome having GC'd the body — getResponseBody throws.
    sendMock.mockImplementation(async (_t: number, method: string) => {
      if (method === "Network.getResponseBody") throw new Error("No data found for resource");
      return undefined;
    });

    let caught: unknown;
    try {
      await m.buildHar(20, {}, true);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RelayError);
    expect((caught as InstanceType<typeof RelayError>).code).toBe("partial_success_disallowed");
    expect((caught as InstanceType<typeof RelayError>).phase).toBe("fetch_bodies");
  });

  it("buildHar(withBodies=true, bestEffortBodies=true) records bodyError instead of throwing", async () => {
    const m = await load();
    await m.ensureNetworkCapture(21);
    dispatch(21, "Network.requestWillBeSent", {
      requestId: "req-bad",
      request: { url: "https://x.com/bad", method: "GET" },
      timestamp: 0, wallTime: 1700000000
    });
    dispatch(21, "Network.responseReceived", {
      requestId: "req-bad",
      response: { url: "https://x.com/bad", status: 200, statusText: "OK", headers: {}, mimeType: "text/plain" }
    });
    dispatch(21, "Network.loadingFinished", { requestId: "req-bad", timestamp: 0.5, encodedDataLength: 5 });

    sendMock.mockImplementation(async (_t: number, method: string) => {
      if (method === "Network.getResponseBody") throw new Error("No data found for resource");
      return undefined;
    });

    const har = (await m.buildHar(21, {}, true, true)) as {
      log: { entries: Array<{ _chrome_relay: { bodyState: string; bodyError?: { code: string; message: string; phase: string } } }> }
    };
    expect(har.log.entries[0]._chrome_relay.bodyState).toBe("error");
    expect(har.log.entries[0]._chrome_relay.bodyError).toBeDefined();
    expect(har.log.entries[0]._chrome_relay.bodyError?.code).toBe("cdp_error");
    expect(har.log.entries[0]._chrome_relay.bodyError?.phase).toBe("Network.getResponseBody");
    // Post-0.5.16: getBody throws a structured RelayError; the buildHar
    // bodyError.message reflects the user-facing GC-explanation rather
    // than the raw underlying CDP string. (The underlying CDP message is
    // still preserved inside bodyError.details when present.)
    expect(har.log.entries[0]._chrome_relay.bodyError?.message).toMatch(/no longer available/);
  });

  it("getBody throws RelayError(target_not_found) when the request isn't in the buffer", async () => {
    const m = await load();
    const { RelayError } = await import("@chrome-relay/protocol");
    await m.ensureNetworkCapture(9);
    let caught: unknown;
    try { await m.getBody(9, "unknown-req"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RelayError);
    const err = caught as InstanceType<typeof RelayError>;
    expect(err.code).toBe("target_not_found");
    expect(err.tool).toBe("chrome_network");
    expect(err.details?.requestId).toBe("unknown-req");
  });

  it("getBody throws RelayError(cdp_error) when CDP says body is gone", async () => {
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
    const { RelayError } = await import("@chrome-relay/protocol");
    let caught: unknown;
    try { await m.getBody(10, "r1"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RelayError);
    const err = caught as InstanceType<typeof RelayError>;
    expect(err.code).toBe("cdp_error");
    expect(err.phase).toBe("Network.getResponseBody");
    expect(err.message).toMatch(/no longer available/);
    // The underlying CDP error is captured in details for debuggability;
    // the exact string depends on which mockImplementation handler the
    // test setup hits first, so just assert it's a non-empty string.
    expect(typeof err.details?.underlying).toBe("string");
    expect((err.details?.underlying as string).length).toBeGreaterThan(0);
  });
});
