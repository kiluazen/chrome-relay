import { agentInputEnded, agentInputStarted, yieldToHuman } from "./human";
import { afterDetachHooks, beforeDetachHooks, setPinHandlers, type PinReason } from "./lease-hooks";

export { onAfterDetach, onBeforeDetach, pinTab, unpinTab, type PinReason } from "./lease-hooks";

const PROTOCOL_VERSION = "1.3";

// Tab leases. The agent borrows a tab: we attach on the first command and
// detach once the tab has been idle for IDLE_DETACH_MS. Detaching ends the
// debugger session, which drops focus emulation, the forced lifecycle state
// and the new-document script, and hides Chrome's "started debugging" bar,
// so a tab the agent is done with is a normal tab again for the person.
//
// A pin keeps the session open while the agent has asked for something that
// only lives inside it (console/network capture, viewport emulation). A
// running screencast needs no pin: its sampling keeps the lease busy. An idle pinned tab goes quiet instead of detaching: input is
// let go and the visibility/focus overrides are undone, so the person gets a
// normal tab back; the next agent command re-applies them. `release`
// (releaseTab/releaseAll) ignores pins.
export const IDLE_DETACH_MS = 30_000;
let idleDetachMs = IDLE_DETACH_MS;
/** E2E hook: a short idle so detach can be observed without a 30s wait. */
export function _setIdleDetachMsForTests(ms: number): void {
  idleDetachMs = ms;
}


interface Lease {
  attachedAt: number;
  lastUsed: number;
  inflight: number;
  lastCommand?: string;
  pins: Set<PinReason>;
  timer?: ReturnType<typeof setTimeout>;
  /** Idle and pinned: overrides undone, session kept for the pin. */
  quiet: boolean;
  /** Page.addScriptToEvaluateOnNewDocument id of the visibility shim. */
  shimScriptId?: string;
}

// Mouse button / keys / drag the agent pressed and has not let go of yet.
// Releases go out in input paths' finally blocks; this is the backstop for
// a sequence cut short (navigation mid-click, SW hiccup, a thrown error)
// so a tab is never left thinking a button or key is still held.
interface HeldInput {
  mouse?: { x: number; y: number; button: string };
  keys: Map<string, Record<string, unknown>>;
  drag?: { x: number; y: number };
}

const leases = new Map<number, Lease>();
const held = new Map<number, HeldInput>();
const inflightAttach = new Map<number, Promise<void>>();
const inflightDetach = new Map<number, Promise<void>>();


// 0.5.17 — force-visible on attach. Tests can opt out to keep their
// existing send/evalExpression mocks (the 3 visibility-shim CDP calls
// would otherwise consume queued `mockResolvedValueOnce` responses).
let forceVisibilityEnabled = true;
export function _setForceVisibilityEnabledForTests(enabled: boolean): void {
  forceVisibilityEnabled = enabled;
}

function forget(tabId: number): void {
  const lease = leases.get(tabId);
  if (lease?.timer) clearTimeout(lease.timer);
  leases.delete(tabId);
  held.delete(tabId);
  for (const hook of afterDetachHooks) {
    try {
      void Promise.resolve(hook(tabId)).catch(() => {});
    } catch {
      /* a hook never blocks cleanup */
    }
  }
}

if (typeof chrome !== "undefined" && chrome.debugger?.onDetach) {
  // Chrome ended the session itself: tab closed or navigated somewhere it
  // can't be debugged, or the person clicked Cancel on the debugging bar.
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === "number" && leases.has(source.tabId)) forget(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (leases.has(tabId)) forget(tabId);
  });
}

function isAlreadyAttached(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Another debugger is already attached/i.test(message);
}

export function isAttached(tabId: number): boolean {
  return leases.has(tabId);
}

export async function ensureAttached(tabId: number): Promise<void> {
  const detaching = inflightDetach.get(tabId);
  if (detaching) await detaching;

  if (leases.has(tabId)) {
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
        // view of the session disagrees with our in-memory lease table. This
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
      const now = Date.now();
      leases.set(tabId, { attachedAt: now, lastUsed: now, inflight: 0, pins: new Set(), quiet: false });
      scheduleIdleDetach(tabId);
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
      // normally throttled. Everything is undone when the lease ends
      // (session-scoped CDP state drops on detach; the in-page shim is
      // reverted by UNPATCH_VISIBILITY_SCRIPT just before).
      if (forceVisibilityEnabled) await forceVisibility(tabId);
    } finally {
      inflightAttach.delete(tabId);
    }
  })();

  inflightAttach.set(tabId, promise);
  await promise;
}

function scheduleIdleDetach(tabId: number): void {
  const lease = leases.get(tabId);
  if (!lease) return;
  if (lease.timer) clearTimeout(lease.timer);
  lease.timer = undefined;
  if (lease.quiet) return;
  lease.timer = setTimeout(() => {
    const current = leases.get(tabId);
    if (!current || current.inflight > 0) return;
    if (current.pins.size > 0) void quietTab(tabId).catch(() => {});
    else void releaseTab(tabId).catch(() => {});
  }, idleDetachMs);
}

// Undo what attaching did to the page, keeping the session for its pins.
async function quietTab(tabId: number): Promise<void> {
  const lease = leases.get(tabId);
  if (!lease || lease.quiet) return;
  lease.quiet = true;
  await undoOverrides(tabId);
  await sendRaw(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  if (lease.shimScriptId) {
    await sendRaw(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: lease.shimScriptId }).catch(() => {});
    lease.shimScriptId = undefined;
  }
}

async function undoOverrides(tabId: number): Promise<void> {
  await releaseHeldInput(tabId);
  for (const hook of beforeDetachHooks) {
    await withTimeout(Promise.resolve().then(() => hook(tabId)), 1_000).catch(() => {});
  }
  await sendRaw(tabId, "Runtime.evaluate", { expression: UNPATCH_VISIBILITY_SCRIPT }).catch(() => {});
}

setPinHandlers(
  (tabId, reason) => {
    const lease = leases.get(tabId);
    if (!lease) return;
    lease.pins.add(reason);
    scheduleIdleDetach(tabId);
  },
  (tabId, reason) => {
    const lease = leases.get(tabId);
    if (!lease) return;
    lease.pins.delete(reason);
    scheduleIdleDetach(tabId);
  }
);

/** End the agent's session on a tab: let go of anything still held, undo
 *  the visibility shim, detach. Ignores pins. Resolves false when we had no
 *  session there. */
export async function releaseTab(tabId: number): Promise<boolean> {
  const pending = inflightDetach.get(tabId);
  if (pending) {
    await pending;
    return true;
  }
  if (!leases.has(tabId)) return false;
  const promise = (async () => {
    const lease = leases.get(tabId);
    if (lease?.timer) clearTimeout(lease.timer);
    if (!lease?.quiet) await undoOverrides(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    forget(tabId);
  })();
  inflightDetach.set(tabId, promise);
  try {
    await promise;
  } finally {
    inflightDetach.delete(tabId);
  }
  return true;
}

/** Release every tab we hold a session on, including sessions left over
 *  from before a service-worker restart (found via chrome.debugger). */
export async function releaseAll(): Promise<number[]> {
  const released = new Set<number>();
  await Promise.all(
    [...leases.keys()].map(async (tabId) => {
      if (await releaseTab(tabId)) released.add(tabId);
    })
  );
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (!t.attached || typeof t.tabId !== "number" || released.has(t.tabId)) continue;
      // detach only succeeds for sessions this extension owns, so DevTools
      // and other extensions are never touched.
      try {
        await chrome.debugger.detach({ tabId: t.tabId });
        released.add(t.tabId);
      } catch {
        /* not ours */
      }
    }
  } catch {
    /* getTargets unavailable: the lease table is all we know */
  }
  return [...released].sort((a, b) => a - b);
}

export interface LeaseInfo {
  tabId: number;
  attachedForMs: number;
  idleForMs: number;
  inflight: number;
  lastCommand?: string;
  pinned: PinReason[];
  /** active: overrides on. quiet: idle + pinned, overrides undone. */
  state: "active" | "quiet";
  /** When the idle timer fires (detach, or go quiet if pinned). null if busy or already quiet. */
  idleActionInMs: number | null;
  holding: string[];
}

export function listLeases(): LeaseInfo[] {
  const now = Date.now();
  return [...leases.entries()].map(([tabId, l]) => {
    const h = held.get(tabId);
    const holding = [
      ...(h?.mouse ? [`mouse:${h.mouse.button}`] : []),
      ...[...(h?.keys.keys() ?? [])].map((k) => `key:${k}`),
      ...(h?.drag ? ["drag"] : [])
    ];
    const timing = l.inflight === 0 && !l.quiet;
    return {
      tabId,
      attachedForMs: now - l.attachedAt,
      idleForMs: now - l.lastUsed,
      inflight: l.inflight,
      ...(l.lastCommand ? { lastCommand: l.lastCommand } : {}),
      pinned: [...l.pins],
      state: l.quiet ? "quiet" : "active",
      idleActionInMs: timing ? Math.max(0, idleDetachMs - (now - l.lastUsed)) : null,
      holding
    };
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const STARTS_INPUT = new Set([
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.dispatchDragEvent",
  "Input.dispatchTouchEvent",
  "Input.insertText",
  "DOM.focus",
  "DOM.setFileInputFiles"
]);

function isReleaseEvent(method: string, params: Record<string, unknown>): boolean {
  const type = params.type;
  return (
    (method === "Input.dispatchMouseEvent" && type === "mouseReleased") ||
    (method === "Input.dispatchKeyEvent" && type === "keyUp") ||
    (method === "Input.dispatchDragEvent" && (type === "drop" || type === "dragCancel")) ||
    (method === "Input.dispatchTouchEvent" && (type === "touchEnd" || type === "touchCancel"))
  );
}

function heldFor(tabId: number): HeldInput {
  let h = held.get(tabId);
  if (!h) {
    h = { keys: new Map() };
    held.set(tabId, h);
  }
  return h;
}

// Keep the held-input table in step with what we send.
function trackInput(tabId: number, method: string, params: Record<string, unknown>): void {
  const type = params.type;
  if (method === "Input.dispatchMouseEvent") {
    if (type === "mousePressed") {
      heldFor(tabId).mouse = { x: Number(params.x) || 0, y: Number(params.y) || 0, button: String(params.button ?? "left") };
    } else if (type === "mouseReleased") {
      const h = held.get(tabId);
      if (h) h.mouse = undefined;
    }
  } else if (method === "Input.dispatchKeyEvent") {
    const id = String(params.code || params.key || "");
    if (!id) return;
    if (type === "keyDown" || type === "rawKeyDown") {
      heldFor(tabId).keys.set(id, params);
    } else if (type === "keyUp") {
      held.get(tabId)?.keys.delete(id);
    }
  } else if (method === "Input.dispatchDragEvent") {
    if (type === "dragEnter" || type === "dragOver") {
      heldFor(tabId).drag = { x: Number(params.x) || 0, y: Number(params.y) || 0 };
    } else if (type === "drop" || type === "dragCancel") {
      const h = held.get(tabId);
      if (h) h.drag = undefined;
    }
  }
}

/** Let go of any button, key or drag still down on this tab. Safe to call
 *  any time; a no-op when nothing is held. */
export async function releaseHeldInput(tabId: number): Promise<void> {
  const h = held.get(tabId);
  if (!h || !leases.has(tabId)) return;
  if (h.mouse) {
    const { x, y, button } = h.mouse;
    await sendRaw(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1, pointerType: "mouse"
    }).catch(() => {});
    h.mouse = undefined;
  }
  for (const [id, down] of [...h.keys]) {
    await sendRaw(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: down.key,
      code: down.code,
      windowsVirtualKeyCode: down.windowsVirtualKeyCode,
      nativeVirtualKeyCode: down.nativeVirtualKeyCode,
      modifiers: 0
    }).catch(() => {});
    h.keys.delete(id);
  }
  if (h.drag) {
    const { x, y } = h.drag;
    await sendRaw(tabId, "Input.dispatchDragEvent", {
      type: "dragCancel", x, y, data: { items: [], dragOperationsMask: 1 }
    }).catch(() => {});
    h.drag = undefined;
  }
}

// Tell Chrome + the page that the tab is visible.
//
// Sequence matters: Page.enable MUST come before addScriptToEvaluateOnNewDocument
// (Chrome silently drops the registration otherwise). We collect errors and
// surface them via console.warn so we can SEE silent failures in the SW log
// instead of just swallowing them — the previous version had all three calls
// best-effort-silent, and one of them was failing for weeks without a hint.
async function forceVisibility(tabId: number): Promise<void> {
  const errors: string[] = [];
  // Enable Page domain — required for addScriptToEvaluateOnNewDocument to
  // actually persist registrations.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
  } catch (e) {
    errors.push(`Page.enable: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Tell Chrome the page lifecycle is active so rAF/setTimeout aren't throttled.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state: "active" });
  } catch (e) {
    errors.push(`Page.setWebLifecycleState: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Make document.hasFocus() return true. Many SPAs gate their initial
  // data fetch on focus, not visibility — Cloudflare's dashboard is the
  // motivating example: visibility-shim alone wasn't enough; focus
  // emulation is what unlocks its render path.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch (e) {
    errors.push(`Emulation.setFocusEmulationEnabled: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Register the visibility shim to run before any page script on EVERY
  // future navigation in this tab.
  try {
    const added = (await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
      source: VISIBILITY_OVERRIDE_SCRIPT
    })) as { identifier?: string } | undefined;
    const lease = leases.get(tabId);
    if (lease && added?.identifier) lease.shimScriptId = added.identifier;
  } catch (e) {
    errors.push(`Page.addScriptToEvaluateOnNewDocument: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Apply the shim to the CURRENTLY-loaded document. If the page is in the
  // middle of its initial JS run and reads visibilityState early, this may
  // arrive too late — but it's strictly better than not patching at all.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: VISIBILITY_OVERRIDE_SCRIPT
    });
  } catch (e) {
    errors.push(`Runtime.evaluate: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (errors.length) {
    console.warn(`[chrome-relay] forceVisibility partial failure on tab ${tabId}:`, errors);
  }
}

// Self-contained, idempotent (re-running is a no-op) — guards on
// __chrome_relay_visibility_patched__ so repeated attaches don't pile up.
const VISIBILITY_OVERRIDE_SCRIPT = `
(() => {
  if (window.__chrome_relay_visibility_patched__) return;
  // Holds what UNPATCH_VISIBILITY_SCRIPT needs to put back.
  Object.defineProperty(window, "__chrome_relay_visibility_patched__", {
    value: { hasFocus: Document.prototype.hasFocus }, configurable: true, writable: true
  });
  // Each override gets its own try/catch — if one fails (deprecated
  // descriptor, frozen prototype), the rest still apply.
  try { Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true }); } catch (e) {}
  try { Object.defineProperty(document, "hidden", { get: () => false, configurable: true }); } catch (e) {}
  try { Object.defineProperty(document, "webkitVisibilityState", { get: () => "visible", configurable: true }); } catch (e) {}
  try { Object.defineProperty(document, "webkitHidden", { get: () => false, configurable: true }); } catch (e) {}
  // hasFocus — patch BOTH the instance and the prototype. Cloudflare-style
  // "wait for focus before fetching" gates may read either path.
  try { document.hasFocus = function () { return true; }; } catch (e) {}
  try { Object.defineProperty(Document.prototype, "hasFocus", { value: function () { return true; }, configurable: true, writable: true }); } catch (e) {}
  // Make window.focus events / activeElement queries look real.
  try { Object.defineProperty(document, "wasDiscarded", { get: () => false, configurable: true }); } catch (e) {}
  // Suppress visibilitychange events so pages that listen for them
  // don't re-fire stale "you've come back" logic on every attach.
  document.addEventListener("visibilitychange", (e) => {
    if (!window.__chrome_relay_visibility_patched__) return; // shim reverted: real events flow again
    if (document.visibilityState === "visible") return; // shim returned visible; nothing to suppress
    e.stopImmediatePropagation();
  }, true);
})();
`;

// Undo VISIBILITY_OVERRIDE_SCRIPT on the live document, so the page sees
// its real visibility and focus again once the agent lets go of the tab.
const UNPATCH_VISIBILITY_SCRIPT = `
(() => {
  const saved = window.__chrome_relay_visibility_patched__;
  if (!saved) return;
  for (const k of ["visibilityState", "hidden", "webkitVisibilityState", "webkitHidden", "wasDiscarded", "hasFocus"]) {
    try { delete document[k]; } catch (e) {}
  }
  try { Object.defineProperty(Document.prototype, "hasFocus", { value: saved.hasFocus, configurable: true, writable: true }); } catch (e) {}
  try { delete window.__chrome_relay_visibility_patched__; } catch (e) {}
})();
`;

/** Send a command on the session as it stands: no attach, no lease
 *  renewal, no input tracking. For cleanup paths. */
export async function sendRaw<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

export async function send<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const releasing = isReleaseEvent(method, params);
  // The person is typing or clicking in this tab: hold new input until they
  // pause. Releases always go through, so a sequence already started ends.
  if (!releasing && STARTS_INPUT.has(method)) await yieldToHuman(tabId);
  await ensureAttached(tabId);
  const lease = leases.get(tabId);
  if (lease?.quiet) {
    lease.quiet = false;
    if (forceVisibilityEnabled) await forceVisibility(tabId);
  }
  if (lease) {
    lease.inflight++;
    lease.lastCommand = method;
  }
  const isInput = method.startsWith("Input.");
  if (isInput) agentInputStarted(tabId);
  try {
    // Mark a press held before sending (it may land even if the call
    // throws); clear a release only once it has gone through.
    if (!releasing) trackInput(tabId, method, params);
    const result = await chrome.debugger.sendCommand(
      { tabId },
      method,
      params
    );
    if (releasing) trackInput(tabId, method, params);
    return result as T;
  } finally {
    if (isInput) agentInputEnded(tabId);
    if (lease) {
      lease.inflight--;
      lease.lastUsed = Date.now();
      scheduleIdleDetach(tabId);
    }
  }
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
