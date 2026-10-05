// Document readiness — "is the page the agent asked for actually there?"
//
// The trap this closes: a tab created with a URL starts on its initial
// about:blank document, whose readyState is already "complete". Until the
// real navigation commits, a readyState probe answers for that blank
// document, so `navigate --new` → `wait --load` → `snapshot` used to pass
// the wait instantly and snapshot an empty page on any non-local site.
//
// Chrome exposes the uncommitted navigation as tab.pendingUrl. A document
// counts as ready only when no navigation is pending AND the committed
// document has reached the requested state.

import { evalExpression } from "./cdp";
import { sleepOrSignal } from "./tab-signal";

export type ReadyState = "commit" | "domcontentloaded" | "load";

export interface ReadyResult {
  ready: boolean;
  url: string;
  readyState?: string;
  waitedMs: number;
  /** The committed document is Chrome's network-error page. */
  errorPage?: boolean;
}

// Upper bound between probes; a navigation signal (tab update, Page event)
// wakes the probe sooner — see tab-signal.ts for why timers alone are slow.
const POLL_MS = 100;

function reached(target: ReadyState, readyState: string, tabStatus: string | undefined): boolean {
  if (target === "commit") return true;
  if (target === "domcontentloaded") return readyState === "interactive" || readyState === "complete";
  return readyState === "complete" && tabStatus === "complete";
}

/** One probe. `null` = no committed document matching the tab yet. */
async function probe(tabId: number): Promise<{ readyState: string; href: string; status?: string; url: string } | null> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.pendingUrl) return null;
  try {
    const r = await evalExpression<{ rs: string; href: string }>(
      tabId,
      `({ rs: document.readyState, href: location.href })`
    );
    if (!r.value) return null;
    return { readyState: r.value.rs, href: r.value.href, status: tab.status, url: tab.url ?? "" };
  } catch {
    // A page we cannot attach to (chrome://, the Web Store) can still finish
    // loading; Chrome's tab status is the only signal left for it.
    if (tab.status === "complete") {
      return { readyState: "complete", href: tab.url ?? "", status: tab.status, url: tab.url ?? "" };
    }
    // Context destroyed mid-navigation — the next poll sees the new document.
    return null;
  }
}

/** Wait until the tab's committed document reaches `target`, or the
 *  deadline passes. Never throws for slowness: callers decide whether a
 *  not-ready page is an error (wait) or a flagged result (snapshot). */
export async function waitForDocument(tabId: number, target: ReadyState, timeoutMs: number): Promise<ReadyResult> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last: Awaited<ReturnType<typeof probe>> = null;
  for (;;) {
    last = await probe(tabId);
    if (last) {
      if (last.href.startsWith("chrome-error://")) {
        return { ready: true, url: last.url, readyState: last.readyState, waitedMs: Date.now() - started, errorPage: true };
      }
      if (reached(target, last.readyState, last.status)) {
        return { ready: true, url: last.url, readyState: last.readyState, waitedMs: Date.now() - started };
      }
    }
    if (Date.now() >= deadline) break;
    await sleepOrSignal(tabId, Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return {
    ready: false,
    url: tab?.pendingUrl ?? tab?.url ?? "",
    ...(last ? { readyState: last.readyState } : {}),
    waitedMs: Date.now() - started
  };
}

/** Cheap pre-check for callers that only wait when they must: true while a
 *  navigation is pending or the committed document is still parsing. */
export async function isDocumentLoading(tabId: number): Promise<boolean> {
  const p = await probe(tabId).catch(() => null);
  return p === null || p.readyState === "loading";
}
