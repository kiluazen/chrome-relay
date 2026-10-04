// DOM settle — "has the page finished reacting to what I just did?"
//
// After a click/fill/keypress that does not navigate, SPAs update the page
// a few ms to a few hundred ms later: a state update, a fetch then a
// render, a debounced search. A snapshot taken immediately reads the frame
// before the reaction and the agent spends another turn re-reading.
//
// Two signals, observed from the moment of the action when the action
// ARMS the tracker (click/fill/keys/type with settle:true), otherwise from
// the start of the snapshot:
//   - DOM mutations, counted by a MutationObserver in a CDP isolated world:
//     it sees the page's DOM, but page scripts can't see or touch it;
//   - in-flight requests, from CDP Network events. Only requests younger
//     than STALE_REQUEST_MS hold the settle — long-polls, beacons and
//     streaming connections would otherwise pin it to the max.
// Settled = no recent request in flight AND the DOM quiet for QUIET_MS.
// Polling runs from the service worker: a background tab's own timers can
// be throttled, ours are not.

import { send } from "./cdp";
import { networkCaptureTabs } from "./network-state";

// Network capture the agent turned on must survive our Network.disable.
const isNetworkCaptureActive = (tabId: number) => networkCaptureTabs.has(tabId);

const QUIET_MS = 150;
/** An armed settle never resolves sooner than this after the action: a
 *  reaction scheduled on the next timer or transition (~200-300ms) has
 *  usually not touched the DOM yet when the CLI's snapshot call arrives. */
const MIN_SINCE_ACTION_MS = 300;
const POLL_MS = 30;
const STALE_REQUEST_MS = 1_000;
/** An armed tracker older than this is stale: the snapshot re-arms. */
const ARM_TTL_MS = 10_000;
const WORLD = "chrome-relay-settle";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SettleResult {
  settled: boolean;
  waitedMs: number;
  /** A navigation started while settling; the caller's readiness wait owns it. */
  navigating?: boolean;
}

interface Tracker {
  armedAt: number;
  contextId: number;
  inflight: Map<string, number>; // requestId → started (ms)
  enabledNetwork: boolean;
}

const trackers = new Map<number, Tracker>();

const LONG_LIVED = new Set(["WebSocket", "EventSource", "Media", "Ping", "Prefetch"]);

if (typeof chrome !== "undefined" && chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const t = typeof source.tabId === "number" ? trackers.get(source.tabId) : undefined;
    if (!t) return;
    const p = params as { requestId?: string; type?: string; request?: { url?: string } };
    if (!p?.requestId) return;
    if (method === "Network.requestWillBeSent") {
      if (p.type && LONG_LIVED.has(p.type)) return;
      if (p.request?.url?.startsWith("chrome-extension://")) return;
      t.inflight.set(p.requestId, Date.now());
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      t.inflight.delete(p.requestId);
    }
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    trackers.delete(tabId);
  });
}

const COUNTER = `(() => {
  const s = globalThis.__crSettle || (globalThis.__crSettle = { n: 0, o: null });
  if (!s.o) {
    s.o = new MutationObserver((records) => { s.n += records.length; });
    s.o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return s.n;
})()`;

const DISCONNECT = `(() => { const s = globalThis.__crSettle; if (s && s.o) { s.o.disconnect(); s.o = null; } return true; })()`;

async function evalIn(tabId: number, contextId: number, expression: string): Promise<number | null> {
  try {
    const r = await send<{ result: { value?: number }; exceptionDetails?: unknown }>(tabId, "Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true
    });
    return r.exceptionDetails ? null : (r.result.value ?? null);
  } catch {
    return null; // context destroyed: the document is being replaced
  }
}

/** Start observing a tab before an action. Best effort: a failure here
 *  only means the later settle observes from its own start instead. */
export async function armSettle(tabId: number): Promise<void> {
  await disarm(tabId);
  try {
    const tree = await send<{ frameTree: { frame: { id: string } } }>(tabId, "Page.getFrameTree");
    const world = await send<{ executionContextId: number }>(tabId, "Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: WORLD
    });
    const t: Tracker = { armedAt: Date.now(), contextId: world.executionContextId, inflight: new Map(), enabledNetwork: false };
    if (!isNetworkCaptureActive(tabId)) {
      await send(tabId, "Network.enable", {});
      t.enabledNetwork = true;
    }
    if ((await evalIn(tabId, t.contextId, COUNTER)) === null) {
      if (t.enabledNetwork) await send(tabId, "Network.disable", {}).catch(() => {});
      return;
    }
    trackers.set(tabId, t);
  } catch {
    /* not armed */
  }
}

async function disarm(tabId: number): Promise<void> {
  const t = trackers.get(tabId);
  if (!t) return;
  trackers.delete(tabId);
  await evalIn(tabId, t.contextId, DISCONNECT);
  if (t.enabledNetwork && !isNetworkCaptureActive(tabId)) {
    await send(tabId, "Network.disable", {}).catch(() => {});
  }
}

/** Wait until the page has stopped reacting (see header), bounded by maxMs
 *  from now. Uses the tracker an action armed, or arms one itself. */
export async function waitForSettle(tabId: number, maxMs: number): Promise<SettleResult> {
  const started = Date.now();
  let t = trackers.get(tabId);
  if (!t || Date.now() - t.armedAt > ARM_TTL_MS) {
    await armSettle(tabId);
    t = trackers.get(tabId);
    // Self-armed (no action announced itself): there is no action to wait
    // out, only the quiet window.
    if (t) t.armedAt -= MIN_SINCE_ACTION_MS;
  }
  if (!t) return { settled: false, waitedMs: Date.now() - started };
  const tracker = t;

  try {
    let last = await evalIn(tabId, tracker.contextId, COUNTER);
    if (last === null) return { settled: false, waitedMs: Date.now() - started, navigating: true };
    let quietSince = Date.now();
    while (Date.now() - started < maxMs) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab?.pendingUrl) return { settled: false, waitedMs: Date.now() - started, navigating: true };
      const n = await evalIn(tabId, tracker.contextId, COUNTER);
      if (n === null) return { settled: false, waitedMs: Date.now() - started, navigating: true };
      const now = Date.now();
      if (n !== last) {
        last = n;
        quietSince = now;
      }
      const busy = [...tracker.inflight.values()].some((since) => now - since < STALE_REQUEST_MS);
      if (busy) quietSince = now;
      else if (now - quietSince >= QUIET_MS && now - tracker.armedAt >= MIN_SINCE_ACTION_MS) {
        return { settled: true, waitedMs: now - started };
      }
      await sleep(POLL_MS);
    }
    return { settled: false, waitedMs: Date.now() - started };
  } finally {
    await disarm(tabId);
  }
}
