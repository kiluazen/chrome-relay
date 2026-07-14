import { describe, it, expect, vi, beforeAll } from "vitest";

// network-buffer registers chrome.debugger/tabs listeners at import time.
let mod: typeof import("../src/browser/network-buffer");
beforeAll(async () => {
  (globalThis as any).chrome = {
    debugger: { onEvent: { addListener: vi.fn() } },
    tabs: { onRemoved: { addListener: vi.fn() } }
  };
  vi.doMock("../src/browser/cdp", () => ({ ensureAttached: vi.fn(), send: vi.fn() }));
  mod = await import("../src/browser/network-buffer");
});
const isSensitiveHeader = (h: string) => mod.isSensitiveHeader(h);
const redactEntry = (e: any) => mod.redactEntry(e);
const redactHar = (h: any) => mod.redactHar(h);
type NetworkEntry = import("../src/browser/network-buffer").NetworkEntry;

describe("network header redaction", () => {
  it("classifies sensitive headers, case-insensitively", () => {
    for (const h of ["Cookie", "set-cookie", "AUTHORIZATION", "x-api-key", "X-CSRF-Token", "x-vendor-session-id", "x-refresh-token"]) {
      expect(isSensitiveHeader(h), h).toBe(true);
    }
    for (const h of ["content-type", "accept", "cache-control", "x-requested-with", "etag", "content-length"]) {
      expect(isSensitiveHeader(h), h).toBe(false);
    }
  });

  it("redactEntry replaces sensitive values, keeps the rest, never mutates the buffer entry", () => {
    const entry = {
      id: "1", startedAt: 0, url: "https://kushalsm.com/api", method: "GET",
      requestHeaders: { Cookie: "secret=1", Accept: "application/json" },
      responseHeaders: { "set-cookie": "sid=abc", "content-type": "text/html" }
    } as unknown as NetworkEntry;
    const out = redactEntry(entry);
    expect(out.requestHeaders?.Cookie).toBe("«redacted»");
    expect(out.requestHeaders?.Accept).toBe("application/json");
    expect(out.responseHeaders?.["set-cookie"]).toBe("«redacted»");
    expect(out.responseHeaders?.["content-type"]).toBe("text/html");
    // original untouched — --raw-headers must still be able to serve it
    expect(entry.requestHeaders?.Cookie).toBe("secret=1");
  });

  it("redactHar scrubs header values and collapses cookie arrays", () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              headers: [{ name: "Authorization", value: "Bearer x" }, { name: "Accept", value: "*/*" }],
              cookies: [{ name: "sid", value: "abc" }, { name: "t", value: "y" }]
            },
            response: { headers: [{ name: "Set-Cookie", value: "sid=abc" }], cookies: [] }
          }
        ]
      }
    };
    const out = redactHar(har) as typeof har;
    const req = out.log.entries[0].request;
    expect(req.headers[0].value).toBe("«redacted»");
    expect(req.headers[1].value).toBe("*/*");
    expect(req.cookies).toEqual([{ name: "«redacted»", value: "2 cookie(s) redacted" }]);
    expect(out.log.entries[0].response.headers[0].value).toBe("«redacted»");
  });
});
