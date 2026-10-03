// Minimal fetch-shaped HTTP client for the per-command hot path (registry
// ping + /call to a local host).
//
// Why not global fetch: every CLI invocation is a fresh process, and the
// first fetch() loads undici — measured ~20ms per command, a quarter of a
// whole `chrome-relay tabs`. node:http is already in the snapshot and does
// the same loopback request in ~2ms. The shape mirrors fetch's subset we
// use, so callers (and test stubs) treat it like fetch.
//
// Loaded with require, not `import`: building the ESM facade for node:http
// reads every export, and one of them lazily loads undici — the exact
// ~10ms this module exists to avoid. require returns the CJS object as-is.

import { createRequire } from "node:module";
import type * as Http from "node:http";

const http = createRequire(import.meta.url)("node:http") as typeof Http;

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export function httpRequest(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(init.signal.reason ?? new Error("aborted"));
      return;
    }
    const headers: Record<string, string | number> = { ...(init.headers ?? {}) };
    if (init.body !== undefined) headers["content-length"] = Buffer.byteLength(init.body);
    const req = http.request(url, { method: init.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json: async () => JSON.parse(text)
        });
      });
    });
    const onAbort = () => req.destroy(init.signal?.reason ?? new Error("aborted"));
    init.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", reject);
    req.on("close", () => init.signal?.removeEventListener("abort", onAbort));
    req.end(init.body);
  });
}
