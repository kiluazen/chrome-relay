// Per-tab console + exception buffer. Wired once at module load; subscribes
// the CDP-side console+log+exception streams whenever a tab is attached, and
// caches recent entries in memory for `chrome-relay console --tab N` to dump.
//
// Why a ring buffer in the SW (not on disk): service workers can be torn
// down at any time; persistence would imply chrome.storage I/O on every
// console event. The right shape for an agent-style "what just happened?"
// is recent-only, in-memory. Wipes on tab close (chrome.tabs.onRemoved).

import { ensureAttached, send } from "./cdp";

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug" | "exception";

export interface ConsoleEntry {
  id: number;                 // monotonic per-tab
  level: ConsoleLevel;
  text: string;               // serialized args (truncated to CONSOLE_ENTRY_TEXT_MAX_CHARS)
  timestamp: number;          // Date.now() at capture
  url?: string;               // source URL when available
  line?: number;
  column?: number;
  stack?: string;             // exception stack (truncated)
}

// Pulled from @chrome-relay/protocol so docs + tests + this file can't drift.
import {
  CONSOLE_BUFFER_MAX_ENTRIES,
  CONSOLE_BUFFER_MAX_BYTES,
  CONSOLE_ENTRY_TEXT_MAX_CHARS,
  CONSOLE_ENTRY_STACK_MAX_CHARS
} from "@chrome-relay/protocol";

interface TabBuffer {
  entries: ConsoleEntry[];
  byteSize: number;
  nextId: number;
  subscribed: boolean;
}

const buffers = new Map<number, TabBuffer>();

function getBuffer(tabId: number): TabBuffer {
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = { entries: [], byteSize: 0, nextId: 1, subscribed: false };
    buffers.set(tabId, buf);
  }
  return buf;
}

function push(tabId: number, entry: Omit<ConsoleEntry, "id">) {
  const buf = getBuffer(tabId);
  const full: ConsoleEntry = { ...entry, id: buf.nextId++ };
  buf.entries.push(full);
  buf.byteSize += full.text.length + (full.stack?.length ?? 0);
  // Drop oldest until we're under both caps.
  while (buf.entries.length > CONSOLE_BUFFER_MAX_ENTRIES || buf.byteSize > CONSOLE_BUFFER_MAX_BYTES) {
    const removed = buf.entries.shift();
    if (!removed) break;
    buf.byteSize -= removed.text.length + (removed.stack?.length ?? 0);
  }
}

// Stringify a CDP RemoteObject list (the `args` of Runtime.consoleAPICalled)
// into a single readable string. Mirrors how DevTools renders it: primitives
// inline, objects as their .description (we don't deep-stringify).
function formatArgs(args: Array<{ value?: unknown; description?: string; type: string }>): string {
  return args
    .map((a) => {
      if (a.value !== undefined && a.value !== null) {
        const v = a.value as unknown;
        if (typeof v === "string") return v;
        try { return JSON.stringify(v); } catch { return String(v); }
      }
      return a.description ?? `<${a.type}>`;
    })
    .join(" ")
    .slice(0, CONSOLE_ENTRY_TEXT_MAX_CHARS);
}

// CDP event payloads (subset of what we care about)
interface ConsoleApiEvent {
  type: string;
  args: Array<{ value?: unknown; description?: string; type: string }>;
  timestamp?: number;
  stackTrace?: {
    callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }>;
  };
}
interface ExceptionThrownEvent {
  timestamp: number;
  exceptionDetails: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: { description?: string };
    stackTrace?: {
      callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }>;
    };
  };
}

function levelFromConsoleType(type: string): ConsoleLevel {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning") return "warn";
  if (type === "info") return "info";
  if (type === "debug" || type === "trace") return "debug";
  return "log";
}

function topFrame(stack: { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> } | undefined) {
  const f = stack?.callFrames?.[0];
  if (!f) return {};
  // Fix #9 (0.3.3): inline-eval frames (what chrome-relay's own `js` tool
  // produces) come through with url="". That confuses agent reasoning —
  // there's no breadcrumb back to the call site. Tag it explicitly so the
  // entry is at least visibly distinguishable from real page-script logs.
  const url = f.url === "" ? "<chrome-relay:js>" : f.url;
  return { url, line: f.lineNumber, column: f.columnNumber };
}

// Subscribe the CDP events for a tab. Idempotent — multiple calls do nothing
// after the first. The actual debugger.onEvent listener is registered once
// at module load (below) and dispatches per-tab.
async function subscribeIfNeeded(tabId: number): Promise<void> {
  const buf = getBuffer(tabId);
  if (buf.subscribed) return;
  await ensureAttached(tabId);
  await send(tabId, "Runtime.enable", {});
  await send(tabId, "Log.enable", {});
  buf.subscribed = true;
}

// Single module-level CDP event listener; routes by source.tabId into the
// right per-tab buffer. Wired once at import time.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") return;
  const buf = buffers.get(source.tabId);
  if (!buf || !buf.subscribed) return;

  switch (method) {
    case "Runtime.consoleAPICalled": {
      const evt = params as ConsoleApiEvent;
      const frame = topFrame(evt.stackTrace);
      push(source.tabId, {
        level: levelFromConsoleType(evt.type),
        text: formatArgs(evt.args ?? []),
        timestamp: evt.timestamp ?? Date.now(),
        url: frame.url,
        line: frame.line,
        column: frame.column
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const evt = params as ExceptionThrownEvent;
      const d = evt.exceptionDetails;
      const frame = topFrame(d.stackTrace);
      push(source.tabId, {
        level: "exception",
        text: (d.exception?.description ?? d.text ?? "<exception>").slice(0, CONSOLE_ENTRY_TEXT_MAX_CHARS),
        timestamp: evt.timestamp,
        url: d.url ?? frame.url,
        line: d.lineNumber ?? frame.line,
        column: d.columnNumber ?? frame.column,
        stack: d.exception?.description?.slice(0, CONSOLE_ENTRY_STACK_MAX_CHARS)
      });
      break;
    }
    case "Log.entryAdded": {
      // Browser-emitted log entries (network warnings, deprecation notices, CSP violations).
      // Promoted to console.log-equivalent so the agent doesn't have to query a separate stream.
      const entry = (params as { entry: { level: string; text: string; source: string; timestamp: number; url?: string; lineNumber?: number } }).entry;
      push(source.tabId, {
        level: entry.level === "error" ? "error" : entry.level === "warning" ? "warn" : "info",
        text: `[${entry.source}] ${entry.text}`.slice(0, CONSOLE_ENTRY_TEXT_MAX_CHARS),
        timestamp: entry.timestamp,
        url: entry.url,
        line: entry.lineNumber
      });
      break;
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId));

// ----- public API used by the chrome_console tool handler -----

export async function ensureConsoleCapture(tabId: number): Promise<void> {
  await subscribeIfNeeded(tabId);
}

export interface ConsoleQuery {
  levels?: ConsoleLevel[];   // filter to these
  since?: number;            // entry id; return entries with id > since
  limit?: number;            // cap response length (default all)
}

export function readConsole(tabId: number, q: ConsoleQuery = {}): { entries: ConsoleEntry[]; nextId: number } {
  const buf = buffers.get(tabId);
  if (!buf) return { entries: [], nextId: 1 };
  let out = buf.entries;
  if (q.levels && q.levels.length > 0) {
    const set = new Set(q.levels);
    out = out.filter((e) => set.has(e.level));
  }
  if (typeof q.since === "number") {
    out = out.filter((e) => e.id > q.since!);
  }
  if (typeof q.limit === "number" && q.limit > 0 && out.length > q.limit) {
    out = out.slice(-q.limit);
  }
  return { entries: out, nextId: buf.nextId };
}

export function clearConsole(tabId: number): { cleared: number } {
  const buf = buffers.get(tabId);
  if (!buf) return { cleared: 0 };
  const n = buf.entries.length;
  buf.entries = [];
  buf.byteSize = 0;
  return { cleared: n };
}
