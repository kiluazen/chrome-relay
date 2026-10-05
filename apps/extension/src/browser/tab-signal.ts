// Sleep that wakes early when the tab does something.
//
// Timers are coarse where Chrome Relay runs: measured in real Chrome and in
// headless Chromium, a 30ms setTimeout in the extension's service worker
// fires after ~120ms (setInterval, scheduler.postTask and Atomics.waitAsync
// behave the same), and a background tab's own timers are just as coarse.
// A poll loop written as "check every 25-50ms" therefore checked every
// ~120-140ms, and every wait that ended between checks paid the gap.
//
// The browser's own signals are not throttled: CDP events for the tab
// (Page.domContentEventFired, Page.loadEventFired, Page.frameNavigated,
// Network.*) and chrome.tabs.onUpdated (url/status/title) arrive as IPC.
// Pollers sleep on this instead of a bare timer: a signal for the tab ends
// the sleep at once and the caller re-checks; the timer remains the upper
// bound for state that produces no signal.

type Waiter = () => void;

const waiters = new Map<number, Set<Waiter>>();

function wake(tabId: number | undefined): void {
  if (typeof tabId !== "number") return;
  const set = waiters.get(tabId);
  if (!set) return;
  waiters.delete(tabId);
  for (const w of set) w();
}

if (typeof chrome !== "undefined") {
  chrome.debugger?.onEvent?.addListener((source) => wake(source.tabId));
  chrome.tabs?.onUpdated?.addListener((tabId) => wake(tabId));
  chrome.tabs?.onRemoved?.addListener((tabId) => wake(tabId));
}

/** Resolve after `ms`, or as soon as the tab emits a CDP event or a tab
 *  update — whichever comes first. Callers re-check their condition. */
export function sleepOrSignal(tabId: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let set = waiters.get(tabId);
    if (!set) waiters.set(tabId, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      waiters.get(tabId)?.delete(waiter);
      resolve();
    };
    const waiter: Waiter = done;
    const timer = setTimeout(done, ms);
    set.add(waiter);
  });
}
