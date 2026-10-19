// Hook + pin registry for debugger-session leases (cdp.ts). Its own module
// so feature modules can register without importing cdp.ts, and tests that
// mock cdp.ts keep working: with cdp mocked, pins are no-ops.

export type PinReason = "console" | "network" | "viewport";
export type DetachHook = (tabId: number) => void | Promise<void>;

export const beforeDetachHooks: DetachHook[] = [];
export const afterDetachHooks: DetachHook[] = [];

/** Runs (best effort, while still attached) before a session ends or goes
 *  quiet. Use sendRaw inside: send() would renew the lease being ended. */
export function onBeforeDetach(hook: DetachHook): void {
  beforeDetachHooks.push(hook);
}

/** Runs after a session ends for any reason (idle, release, the person
 *  cancelling the debugging bar, the tab closing). Reset per-session state. */
export function onAfterDetach(hook: DetachHook): void {
  afterDetachHooks.push(hook);
}

let pinImpl: (tabId: number, reason: PinReason) => void = () => {};
let unpinImpl: (tabId: number, reason: PinReason) => void = () => {};

export function setPinHandlers(
  pin: (tabId: number, reason: PinReason) => void,
  unpin: (tabId: number, reason: PinReason) => void
): void {
  pinImpl = pin;
  unpinImpl = unpin;
}

/** Keep this tab's session open (quiet when idle) until unpinned or released. */
export function pinTab(tabId: number, reason: PinReason): void {
  pinImpl(tabId, reason);
}

export function unpinTab(tabId: number, reason: PinReason): void {
  unpinImpl(tabId, reason);
}
