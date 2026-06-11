// Global RefMap — adoption-spec Change 2.
//
// One browser-wide map of @eN refs. The counter is global and monotonic, so
// every ref is unique across tabs and CARRIES its tab identity in the entry.
// That's the rule that makes bare `click @e3` tab-safe: the ref resolves to
// the tab that produced it, never to whatever tab the user happens to be
// looking at. A snapshot of tab A invalidates only tab A's previous refs.
//
// This is the third instance of the per-tab-state-in-the-SW pattern
// (console-buffer.ts and network-buffer.ts are the others) — but the first
// where staleness causes a WRONG ACTION instead of missing data. Two
// guardrails are load-bearing:
//   1. No caller acts on an entry without re-verifying it through CDP
//      (DOM.getBoxModel on the backendNodeId IS the verification).
//   2. Entries hydrated from chrome.storage.session (MV3 SW restarts) go
//      through the same verification — hydration restores ids, not trust.

import type { SnapshotRefEntry } from "@chrome-relay/protocol";

const STORAGE_KEY = "chrome_relay_ref_map_v1";
// Hard cap on total entries — a runaway multi-tab session can't grow the
// map (and the storage.session write) without bound. Oldest tabs evict
// first; their refs were stale anyway.
const MAX_ENTRIES = 2000;

interface PersistedRefMap {
  counter: number;
  entries: [string, SnapshotRefEntry][];
}

let counter = 0;
const entries = new Map<string, SnapshotRefEntry>();

// Hydrate once per SW lifetime. Accessors await this so a freshly-restarted
// service worker still resolves refs handed out by its previous incarnation.
let hydrated: Promise<void> | null = null;
function ensureHydrated(): Promise<void> {
  if (!hydrated) {
    hydrated = (async () => {
      try {
        const stored = await chrome.storage.session.get(STORAGE_KEY);
        const raw = stored?.[STORAGE_KEY] as PersistedRefMap | undefined;
        if (raw && typeof raw.counter === "number" && Array.isArray(raw.entries)) {
          counter = Math.max(counter, raw.counter);
          for (const [ref, entry] of raw.entries) {
            if (!entries.has(ref)) entries.set(ref, entry);
          }
        }
      } catch {
        // storage.session unavailable (old Chrome, tests) — in-memory only.
      }
    })();
  }
  return hydrated;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload: PersistedRefMap = { counter, entries: [...entries.entries()] };
    void chrome.storage.session.set({ [STORAGE_KEY]: payload }).catch(() => {
      /* best effort — in-memory map stays authoritative */
    });
  }, 50);
}

/** Drop every ref belonging to a tab. Called at the start of each snapshot
 *  of that tab (refs are snapshot-scoped) and on tab close. */
export async function invalidateTabRefs(tabId: number): Promise<void> {
  await ensureHydrated();
  for (const [ref, entry] of entries) {
    if (entry.tabId === tabId) entries.delete(ref);
  }
  schedulePersist();
}

/** Allocate the next global ref id for an entry. Returns "eN". */
export function allocateRef(entry: SnapshotRefEntry): string {
  // Evict oldest entries (lowest counter = front of insertion order) when
  // over cap. Map preserves insertion order, so the first keys are oldest.
  while (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  counter += 1;
  const ref = `e${counter}`;
  entries.set(ref, entry);
  schedulePersist();
  return ref;
}

export async function getRefEntry(ref: string): Promise<SnapshotRefEntry | undefined> {
  await ensureHydrated();
  return entries.get(ref);
}

/** Write a fresh backendNodeId back after a successful role/name/nth heal —
 *  our addition over agent-browser (their resolver re-finds every time). */
export async function healRefEntry(ref: string, backendNodeId: number): Promise<void> {
  await ensureHydrated();
  const entry = entries.get(ref);
  if (entry) {
    entries.set(ref, { ...entry, backendNodeId });
    schedulePersist();
  }
}

/** Test/diagnostic surface. */
export function refMapSize(): number {
  return entries.size;
}

export function resetRefMapForTests(): void {
  counter = 0;
  entries.clear();
  hydrated = Promise.resolve();
}

// Tab closed → its refs are dead. Registered at module top level so the MV3
// SW re-registers on every restart. Guarded for non-extension test envs.
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void invalidateTabRefs(tabId);
  });
}

// Tab navigated → its refs are dead, and worse than dead: Chromium REUSES
// backendNodeId integers in the new document, so a stale ref's fast path can
// silently resolve to an unrelated element and click it (observed live: a
// front-page ref clicked a random story on /newest). Real navigations fire
// onUpdated with status "loading"; SPA route changes (pushState) fire with
// only a url change and keep their DOM — those refs stay valid and the
// role/name heal covers the churn.
if (typeof chrome !== "undefined" && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      void invalidateTabRefs(tabId);
    }
  });
}
