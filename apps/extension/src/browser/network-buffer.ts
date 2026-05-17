// Per-tab network capture (§2.7a of boundaries.md).
//
// Subscribes to Network.* CDP events, joins per-request fragments into a
// single entry, holds them in an in-memory ring buffer per tab. On demand
// emits a HAR-compatible subset (entries.{request,response,timings} — the
// parts every consumer cares about; pages/creator/comment left empty per
// design call #2).
//
// Bodies are NOT eagerly buffered (design call #1: lazy). `getBody(reqId)`
// calls Network.getResponseBody at request time and may fail with "body no
// longer available" — Chrome GCs response bodies after ~30s. Honest is
// better than 50MB of memory pressure on a media-heavy page.
//
// WebSocket / SSE frames are explicitly out of scope (design call #3).

import { ensureAttached, send } from "./cdp";

const PER_TAB_MAX = 200;             // entries in the ring
const PER_TAB_MAX_BYTES = 512 * 1024; // metadata only — bodies aren't stored

export interface NetworkEntry {
  id: string;                  // requestId from CDP, used to fetch body on demand
  startedAt: number;           // wall-clock ms
  url: string;
  method: string;
  status?: number;             // undefined while in-flight
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  // CDP timing block — millisecond offsets from the request start. We forward
  // the raw object instead of pre-computing "TTFB" so consumers can choose.
  timings?: {
    dnsStart?: number; dnsEnd?: number;
    connectStart?: number; connectEnd?: number;
    sslStart?: number; sslEnd?: number;
    sendStart?: number; sendEnd?: number;
    receiveHeadersEnd?: number;
  };
  encodedBodySize?: number;
  decodedBodySize?: number;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  failed?: { errorText: string; canceled: boolean };
  finishedAt?: number;
}

interface TabBuffer {
  entries: NetworkEntry[];     // ordered by startedAt
  byId: Map<string, NetworkEntry>;
  byteSize: number;
  subscribed: boolean;
}

const buffers = new Map<number, TabBuffer>();

function getBuffer(tabId: number): TabBuffer {
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = { entries: [], byId: new Map(), byteSize: 0, subscribed: false };
    buffers.set(tabId, buf);
  }
  return buf;
}

function pruneIfFull(buf: TabBuffer) {
  while (buf.entries.length > PER_TAB_MAX || buf.byteSize > PER_TAB_MAX_BYTES) {
    const oldest = buf.entries.shift();
    if (!oldest) break;
    buf.byId.delete(oldest.id);
    buf.byteSize -= entrySize(oldest);
  }
}

function entrySize(e: NetworkEntry): number {
  // Rough memory accounting — close enough for ring eviction.
  return (
    e.url.length +
    (e.requestHeaders ? Object.entries(e.requestHeaders).reduce((a, [k, v]) => a + k.length + String(v).length, 0) : 0) +
    (e.responseHeaders ? Object.entries(e.responseHeaders).reduce((a, [k, v]) => a + k.length + String(v).length, 0) : 0)
  );
}

async function subscribeIfNeeded(tabId: number): Promise<void> {
  const buf = getBuffer(tabId);
  if (buf.subscribed) return;
  await ensureAttached(tabId);
  await send(tabId, "Network.enable", {});
  buf.subscribed = true;
}

// CDP event payloads — only what we read.
interface RequestWillBeSentEvt {
  requestId: string;
  request: { url: string; method: string; headers?: Record<string, string> };
  timestamp: number;
  wallTime: number;
}
interface ResponseReceivedEvt {
  requestId: string;
  response: {
    url: string;
    status: number;
    statusText: string;
    headers?: Record<string, string>;
    mimeType?: string;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
    timing?: NetworkEntry["timings"];
  };
}
interface LoadingFinishedEvt {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
}
interface LoadingFailedEvt {
  requestId: string;
  timestamp: number;
  errorText: string;
  canceled: boolean;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  const buf = buffers.get(source.tabId);
  if (!buf || !buf.subscribed) return;

  switch (method) {
    case "Network.requestWillBeSent": {
      const evt = params as RequestWillBeSentEvt;
      // Filter out our own injected console-recorder and any other
      // chrome-extension://-origin noise. Agents shouldn't see this.
      if (evt.request.url.startsWith("chrome-extension://")) return;
      // Same requestId can fire twice in redirect chains; the second wins.
      const existing = buf.byId.get(evt.requestId);
      const entry: NetworkEntry = existing ?? {
        id: evt.requestId,
        startedAt: evt.wallTime * 1000,
        url: evt.request.url,
        method: evt.request.method,
        requestHeaders: evt.request.headers
      };
      entry.url = evt.request.url;
      entry.method = evt.request.method;
      entry.requestHeaders = evt.request.headers;
      if (!existing) {
        buf.entries.push(entry);
        buf.byId.set(entry.id, entry);
        buf.byteSize += entrySize(entry);
      }
      pruneIfFull(buf);
      break;
    }
    case "Network.responseReceived": {
      const evt = params as ResponseReceivedEvt;
      const entry = buf.byId.get(evt.requestId);
      if (!entry) return;
      entry.status = evt.response.status;
      entry.statusText = evt.response.statusText;
      entry.mimeType = evt.response.mimeType;
      entry.responseHeaders = evt.response.headers;
      entry.timings = evt.response.timing;
      entry.fromDiskCache = evt.response.fromDiskCache;
      entry.fromServiceWorker = evt.response.fromServiceWorker;
      buf.byteSize += entrySize(entry) / 2;  // rough delta — responseHeaders added
      pruneIfFull(buf);
      break;
    }
    case "Network.loadingFinished": {
      const evt = params as LoadingFinishedEvt;
      const entry = buf.byId.get(evt.requestId);
      if (!entry) return;
      entry.finishedAt = entry.startedAt + evt.timestamp * 1000;
      entry.encodedBodySize = evt.encodedDataLength;
      break;
    }
    case "Network.loadingFailed": {
      const evt = params as LoadingFailedEvt;
      const entry = buf.byId.get(evt.requestId);
      if (!entry) return;
      entry.failed = { errorText: evt.errorText, canceled: evt.canceled };
      entry.finishedAt = entry.startedAt + evt.timestamp * 1000;
      break;
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId));

// ----- public API -----

export async function ensureNetworkCapture(tabId: number): Promise<void> {
  await subscribeIfNeeded(tabId);
}

export interface NetworkQuery {
  filter?: string;             // url substring (case-insensitive)
  status?: "ok" | "redirect" | "client_error" | "server_error" | "failed";
  method?: string;             // exact match, uppercased
  limit?: number;
}

export function readNetwork(tabId: number, q: NetworkQuery = {}): { entries: NetworkEntry[]; total: number } {
  const buf = buffers.get(tabId);
  if (!buf) return { entries: [], total: 0 };
  let out = buf.entries;
  if (q.filter) {
    const f = q.filter.toLowerCase();
    out = out.filter((e) => e.url.toLowerCase().includes(f));
  }
  if (q.status) {
    out = out.filter((e) => bucketStatus(e) === q.status);
  }
  if (q.method) {
    const m = q.method.toUpperCase();
    out = out.filter((e) => e.method === m);
  }
  const total = out.length;
  if (typeof q.limit === "number" && q.limit > 0 && out.length > q.limit) {
    out = out.slice(-q.limit);
  }
  return { entries: out, total };
}

function bucketStatus(e: NetworkEntry): "ok" | "redirect" | "client_error" | "server_error" | "failed" | undefined {
  if (e.failed) return "failed";
  if (typeof e.status !== "number") return undefined;
  if (e.status >= 500) return "server_error";
  if (e.status >= 400) return "client_error";
  if (e.status >= 300) return "redirect";
  return "ok";
}

export async function getBody(tabId: number, requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
  const buf = buffers.get(tabId);
  if (!buf || !buf.byId.has(requestId)) {
    throw new Error(`Request ${requestId} not in this tab's network buffer.`);
  }
  try {
    const resp = await send<{ body: string; base64Encoded: boolean }>(tabId, "Network.getResponseBody", { requestId });
    return resp;
  } catch (e) {
    throw new Error(
      `Response body for ${requestId} is no longer available (Chrome GCs bodies after ~30s). ` +
        `Capture again or fetch the body sooner. (${e instanceof Error ? e.message : String(e)})`
    );
  }
}

export function clearNetwork(tabId: number): { cleared: number } {
  const buf = buffers.get(tabId);
  if (!buf) return { cleared: 0 };
  const n = buf.entries.length;
  buf.entries = [];
  buf.byId.clear();
  buf.byteSize = 0;
  return { cleared: n };
}

// HAR-compatible subset (design call #2). Covers entries[].{request, response,
// timings}. pages/creator/comment intentionally empty — most consumers
// (Postman, Charles, browser DevTools "Import HAR") read entries first and
// ignore the rest. Strict-HAR consumers (Wireshark) may complain; we accept
// that tradeoff in exchange for ~150 LOC of spec compliance we don't need yet.
//
// withBodies: body fetch via Network.getResponseBody.
//
// Code-quality-hardening PR 4 (Risk 6): bodyState is one of
//   "fetched"        — body retrieved and present in entry.response.content.text
//   "skipped"        — request was failed / no status → never tried
//   "missing"        — fetch attempted, returned null/empty
//   "error"          — fetch threw (CDP error, GC'd, permission denied, etc.)
// When state is "error", `_chrome_relay.bodyError` is populated with the
// CDP failure reason so the caller can distinguish "GC'd" from "permission
// denied" from "request still in flight."
//
// bestEffortBodies (default false): when withBodies is requested and ANY
// body fails to fetch, the whole call throws partial_success_disallowed
// — the agent asked for bodies, they didn't all arrive. Pass
// bestEffortBodies:true to keep the legacy behavior: missing bodies are
// reported per-entry, no global failure.
export async function buildHar(
  tabId: number,
  q: NetworkQuery = {},
  withBodies = false,
  bestEffortBodies = false
): Promise<unknown> {
  const { entries } = readNetwork(tabId, q);

  // Pre-fetch bodies in parallel (cap at 8 concurrent so we don't pound CDP).
  const bodyState = new Map<string, "fetched" | "missing" | "skipped" | "error">();
  const bodyError = new Map<string, { code: string; message: string; phase: string }>();
  const bodyText  = new Map<string, { body: string; base64Encoded: boolean }>();
  if (withBodies) {
    const concurrency = 8;
    for (let i = 0; i < entries.length; i += concurrency) {
      const slice = entries.slice(i, i + concurrency);
      await Promise.all(slice.map(async (e) => {
        if (e.failed || typeof e.status !== "number") {
          bodyState.set(e.id, "skipped");
          return;
        }
        try {
          const r = await getBody(tabId, e.id);
          if (!r.body) {
            bodyState.set(e.id, "missing");
            return;
          }
          bodyText.set(e.id, r);
          bodyState.set(e.id, "fetched");
        } catch (err) {
          bodyState.set(e.id, "error");
          bodyError.set(e.id, {
            code: "cdp_error",
            message: err instanceof Error ? err.message : String(err),
            phase: "Network.getResponseBody"
          });
        }
      }));
    }
  }

  // Strict by default: if withBodies was requested and any body failed
  // (error OR missing), surface the failure. Caller opts into the legacy
  // behavior via bestEffortBodies:true.
  if (withBodies && !bestEffortBodies) {
    const failed: Array<{ id: string; url: string; state: string }> = [];
    for (const e of entries) {
      const st = bodyState.get(e.id);
      if (st === "error" || st === "missing") {
        failed.push({ id: e.id, url: e.url, state: st });
      }
    }
    if (failed.length > 0) {
      const { RelayError } = await import("@chrome-relay/protocol");
      throw new RelayError({
        code: "partial_success_disallowed",
        message: `chrome_network har --with-bodies: ${failed.length} of ${entries.length} bodies failed to fetch. Pass bestEffortBodies:true to keep the HAR with per-entry bodyState/bodyError.`,
        tool: "chrome_network",
        phase: "fetch_bodies",
        details: {
          totalEntries: entries.length,
          failedCount: failed.length,
          failed: failed.slice(0, 10)
        },
        retryable: false
      });
    }
  }
  return {
    log: {
      version: "1.2",
      creator: { name: "chrome-relay", version: "0.2.x" },
      pages: [],
      entries: entries.map((e) => ({
        startedDateTime: new Date(e.startedAt).toISOString(),
        time: e.finishedAt && e.startedAt ? Math.max(0, e.finishedAt - e.startedAt) : -1,
        request: {
          method: e.method,
          url: e.url,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: Object.entries(e.requestHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
          queryString: [],
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: e.status ?? 0,
          statusText: e.statusText ?? "",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: Object.entries(e.responseHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
          content: (() => {
            const fetched = bodyText.get(e.id);
            const c: Record<string, unknown> = {
              size: e.decodedBodySize ?? -1,
              mimeType: e.mimeType ?? ""
            };
            // Fix #3 (chrome-relay 0.3.3): the CDP Network.getResponseBody
            // response field is `body`, not `text`. Reading `.text` silently
            // returned undefined → HAR entries had no text even with
            // --with-bodies. The fetch was working; the write was broken.
            if (fetched) {
              c.text = fetched.body;
              if (fetched.base64Encoded) c.encoding = "base64";
            }
            return c;
          })(),
          redirectURL: e.responseHeaders?.["location"] ?? e.responseHeaders?.["Location"] ?? "",
          headersSize: -1,
          bodySize: e.encodedBodySize ?? -1
        },
        cache: {},
        timings: {
          blocked: -1,
          dns: timingDelta(e.timings?.dnsStart, e.timings?.dnsEnd),
          connect: timingDelta(e.timings?.connectStart, e.timings?.connectEnd),
          ssl: timingDelta(e.timings?.sslStart, e.timings?.sslEnd),
          send: timingDelta(e.timings?.sendStart, e.timings?.sendEnd),
          wait: e.timings?.receiveHeadersEnd ?? -1,
          receive: -1
        },
        _chrome_relay: (() => {
          const meta: Record<string, unknown> = {
            requestId: e.id,
            fromDiskCache: e.fromDiskCache,
            fromServiceWorker: e.fromServiceWorker,
            failed: e.failed,
            bodyState: bodyState.get(e.id) ?? (withBodies ? "missing" : "skipped")
          };
          const err = bodyError.get(e.id);
          if (err) meta.bodyError = err;
          return meta;
        })()
      }))
    }
  };
}

function timingDelta(start?: number, end?: number): number {
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < 0) return -1;
  return Math.max(0, end - start);
}
