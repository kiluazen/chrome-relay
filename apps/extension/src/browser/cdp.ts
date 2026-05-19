const PROTOCOL_VERSION = "1.3";

const attached = new Set<number>();
const inflightAttach = new Map<number, Promise<void>>();

// 0.5.17 — force-visible on attach. Tests can opt out to keep their
// existing send/evalExpression mocks (the 3 visibility-shim CDP calls
// would otherwise consume queued `mockResolvedValueOnce` responses).
let forceVisibilityEnabled = true;
export function _setForceVisibilityEnabledForTests(enabled: boolean): void {
  forceVisibilityEnabled = enabled;
}

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    attached.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

function isAlreadyAttached(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Another debugger is already attached/i.test(message);
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) {
    return;
  }

  const existing = inflightAttach.get(tabId);
  if (existing) {
    await existing;
    return;
  }

  const promise = (async () => {
    try {
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      } catch (err) {
        // Chrome reports "Another debugger is already attached" when its OS-level
        // view of the session disagrees with our in-memory `attached` Set. This
        // happens whenever cdp state goes out of sync — e.g. if our SW restarted
        // and the previous session is still live, or if another tool path attached
        // outside ensureAttached. chrome.debugger.detach succeeds only for the
        // extension that owns the session, so it doubles as an ownership probe:
        // if we own it, this clears the stale state; if someone else owns it
        // (DevTools, another extension), detach throws and we re-throw a clearer
        // error pointing the user at the right resolution.
        if (!isAlreadyAttached(err)) throw err;
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          throw new Error(
            `Tab ${tabId} is being debugged by Chrome DevTools or another ` +
              `extension. Close DevTools, detach the other extension, or use a ` +
              `different tab.`
          );
        }
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      }
      attached.add(tabId);
      // 0.5.17 — force-visible by default.
      //
      // Why: backgrounded tabs throttle their own JS in two ways: (a) the
      // page reads `document.hidden` / `document.visibilityState` and skips
      // work, and (b) Chrome clamps `requestAnimationFrame` and `setTimeout`
      // to ~1Hz. Heavy SPAs (Cloudflare dashboard, Linear, Notion) get
      // wedged on their initial spinner because their data fetch is gated
      // on the first rAF tick that never comes. Chrome-relay's whole pitch
      // is "operate on backgrounded tabs without stealing focus" — and that
      // pitch silently broke whenever the page was visibility-gated.
      //
      // Belt + suspenders: setWebLifecycleState fixes Chrome's throttling;
      // the inline script overrides the page-visible API surface so the
      // site's own `if (document.hidden) return` checks see "visible." Both
      // are scoped to this one tab — other tabs the user has open stay
      // normally throttled. Override clears automatically when we detach.
      if (forceVisibilityEnabled) await forceVisibility(tabId);
    } finally {
      inflightAttach.delete(tabId);
    }
  })();

  inflightAttach.set(tabId, promise);
  await promise;
}

// Tell Chrome + the page that the tab is visible. Best-effort: failures
// don't block attach (some pages — chrome://, the Web Store — can't be
// touched at this level, and that's fine; the original tool call will
// fail with a clearer error if needed).
async function forceVisibility(tabId: number): Promise<void> {
  try {
    // Layer 1: Chrome stops throttling rAF/timers on this tab.
    await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" });
  } catch {
    /* not all targets support this; ignore */
  }
  try {
    // Layer 2: install a script that runs on every navigation in this tab
    // and overrides the visibility API surface so the page's own checks
    // see "visible." Page.addScriptToEvaluateOnNewDocument fires before
    // any page script. Effective for future navigations.
    await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
      source: VISIBILITY_OVERRIDE_SCRIPT
    });
  } catch { /* ignore */ }
  try {
    // Layer 3: apply the same shim to the CURRENTLY-loaded document via a
    // one-shot Runtime.evaluate. The new-document script only catches
    // future loads; this one catches the page we just attached to.
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: VISIBILITY_OVERRIDE_SCRIPT
    });
  } catch { /* ignore */ }
}

// Self-contained, idempotent (re-running is a no-op) — guards on
// __chrome_relay_visibility_patched__ so repeated attaches don't pile up.
const VISIBILITY_OVERRIDE_SCRIPT = `
(() => {
  if (window.__chrome_relay_visibility_patched__) return;
  window.__chrome_relay_visibility_patched__ = true;
  try {
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "webkitVisibilityState", { get: () => "visible", configurable: true });
    Object.defineProperty(document, "webkitHidden", { get: () => false, configurable: true });
  } catch (e) { /* some pages froze descriptors before us; tolerate */ }
  // Suppress visibilitychange events so pages that listen for them
  // don't re-fire stale "you've come back" logic on every attach.
  document.addEventListener("visibilitychange", (e) => {
    if (document.visibilityState === "visible") return; // shim returned visible; nothing to suppress
    e.stopImmediatePropagation();
  }, true);
})();
`;

export async function send<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand(
    { tabId },
    method,
    params
  );
  return result as T;
}

interface RuntimeEvaluateResponse<TResult> {
  result: { value?: TResult; type: string };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

export interface EvalOptions {
  userGesture?: boolean;
  timeout?: number;
}

export async function evalExpression<TResult = unknown>(
  tabId: number,
  expression: string,
  options: EvalOptions = {}
): Promise<{ value?: TResult; type: string }> {
  const response = await send<RuntimeEvaluateResponse<TResult>>(
    tabId,
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...options
    }
  );

  if (response.exceptionDetails) {
    const message =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text;
    throw new Error(message);
  }

  return response.result;
}

export async function evalInTab<TArgs extends unknown[], TResult>(
  tabId: number,
  fn: (...args: TArgs) => TResult,
  args: TArgs
): Promise<TResult> {
  const expression = `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
  const result = await evalExpression<TResult>(tabId, expression);
  return result.value as TResult;
}
