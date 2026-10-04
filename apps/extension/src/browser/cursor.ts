// Agent cursor — an arrow drawn in the page where the agent points, clicks
// and types, so a person glancing at the tab sees what the agent is doing
// (and screencast recordings show it). The user's real mouse is never
// touched: input still goes through CDP, the arrow is decoration.
//
// Rules it keeps:
//   - Never slows an action: moving the arrow is one Runtime.evaluate that
//     starts a time-based animation and returns. Input is dispatched right
//     after; the arrow catches up on its own.
//   - Invisible to the page's logic: the code runs in a CDP isolated world
//     (page scripts can't call or tamper with it), the drawing lives in a
//     CLOSED shadow root, the host is aria-hidden (no AX node, so snapshots
//     never see it), zero-sized with pointer-events:none (hit tests and
//     clicks go straight through). The only light-DOM change is appending
//     the host once per document; every later move happens inside the
//     shadow tree, which page MutationObservers don't observe.
//   - Off with `chrome-relay cursor off` (stored in chrome.storage.local).
//
// Motion: a curved glide to the target (duration scales with distance),
// a ring pulse on click, then a slow wiggle while the agent is between
// commands — thinking — and a fade-out once it has been idle for a while.

import { send } from "./cdp";

export type CursorKind = "click" | "hover" | "type";

const WORLD = "chrome-relay-cursor";
const STORAGE_KEY = "agentCursorEnabled";

// Context ids of the isolated world per tab, while its document lives.
const contexts = new Map<number, number>();
let enabledCache: boolean | null = null;

if (typeof chrome !== "undefined" && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") contexts.delete(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => contexts.delete(tabId));
}

export async function isCursorEnabled(): Promise<boolean> {
  if (enabledCache !== null) return enabledCache;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    enabledCache = stored?.[STORAGE_KEY] !== false;
  } catch {
    enabledCache = true;
  }
  return enabledCache;
}

export async function setCursorEnabled(enabled: boolean): Promise<void> {
  enabledCache = enabled;
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  if (!enabled) {
    for (const tabId of [...contexts.keys()]) await callCursor(tabId, "remove()").catch(() => {});
  }
}

// Installed once per isolated world; idempotent. Self-contained string:
// it runs in the page's renderer, not here.
const INSTALL = `(() => {
  const g = globalThis;
  if (g.__crCursor && g.__crCursor.alive()) return true;
  const host = document.createElement("chrome-relay-cursor");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = [
    "position:fixed", "top:0", "left:0", "width:0", "height:0", "overflow:visible",
    "pointer-events:none", "z-index:2147483647", "display:block", "margin:0", "padding:0",
    "border:0", "cursor:default", "contain:layout style"
  ].map((d) => d + "!important").join(";");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = \`
<style>
  :host { all: initial; }
  .c { position: absolute; left: 0; top: 0; will-change: transform, opacity; opacity: 0;
       transition: opacity 240ms ease; }
  .c.on { opacity: 1; }
  .c.gone { opacity: 0; transition-duration: 900ms; }
  .c.hidden { visibility: hidden; }
  .a { position: absolute; left: -3.5px; top: -2.3px; width: 30px; height: 35px; overflow: visible;
       transform-origin: 3.5px 2.3px;
       filter: drop-shadow(0 0 4px rgba(34, 211, 238, .75)) drop-shadow(0 2px 3px rgba(4, 28, 30, .35)); }
  .c.think .a { animation: think 1.6s ease-in-out infinite; }
  .ring { position: absolute; left: -16px; top: -16px; width: 32px; height: 32px; border-radius: 50%;
          border: 2px solid #22d3ee; opacity: 0; transform: scale(.4); }
  .ring.go { animation: pulse 520ms cubic-bezier(.2,.7,.2,1); }
  .tag { position: absolute; left: 20px; top: 22px; font: 600 10px/1 ui-sans-serif, system-ui, sans-serif;
         letter-spacing: .02em; color: #fffdf7; background: #0f3d3e; border: 1px solid #22d3ee;
         border-radius: 999px; padding: 3px 7px; white-space: nowrap; opacity: 0;
         transform: translateY(2px); transition: opacity 180ms ease, transform 180ms ease; }
  .c.typing .tag { opacity: 1; transform: none; }
  @keyframes think { 0%, 100% { transform: rotate(0deg); } 30% { transform: rotate(-9deg); } 65% { transform: rotate(6deg); } }
  @keyframes pulse { 0% { opacity: .95; transform: scale(.4); } 100% { opacity: 0; transform: scale(1.6); } }
</style>
<div class="c"><div class="ring"></div>
  <svg class="a" viewBox="0 0 26 30" aria-hidden="true">
    <path d="M3 2 L3 24 L9 18.5 L13.2 27.5 L17.4 25.6 L13.3 16.8 L21.5 16.8 Z"
          fill="#0f3d3e" stroke="#fffdf7" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>
  <div class="tag">typing</div>
</div>\`;
  (document.documentElement || document).appendChild(host);
  const c = root.querySelector(".c");
  const ring = root.querySelector(".ring");
  let x = Math.round(innerWidth * 0.62), y = Math.round(innerHeight * 0.72);
  let anim = null, thinkTimer = 0, fadeTimer = 0;
  const place = () => { c.style.transform = "translate(" + x + "px," + y + "px)"; };
  place();
  const idle = () => {
    clearTimeout(thinkTimer); clearTimeout(fadeTimer);
    thinkTimer = setTimeout(() => c.classList.add("think"), 450);
    fadeTimer = setTimeout(() => { c.classList.remove("think", "typing"); c.classList.add("gone"); }, 15000);
  };
  const wake = () => {
    c.classList.remove("think", "gone", "typing");
    c.classList.add("on");
  };
  g.__crCursor = {
    alive: () => host.isConnected,
    move(tx, ty, kind) {
      wake();
      const fx = x, fy = y;
      const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy);
      // A gentle arc, bending to one side, like a hand moving a mouse.
      const bend = Math.min(90, d * 0.22) * (Math.random() < 0.5 ? -1 : 1);
      const cx = fx + dx / 2 - (dy / (d || 1)) * bend, cy = fy + dy / 2 + (dx / (d || 1)) * bend;
      const frames = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16, u = 1 - t;
        const px = u * u * fx + 2 * u * t * cx + t * t * tx, py = u * u * fy + 2 * u * t * cy + t * t * ty;
        frames.push({ transform: "translate(" + px + "px," + py + "px)" });
      }
      if (anim) anim.cancel();
      x = tx; y = ty; place();
      const duration = d < 2 ? 0 : Math.max(160, Math.min(460, 120 + d * 0.35));
      anim = duration ? c.animate(frames, { duration, easing: "cubic-bezier(.3,.6,.2,1)" }) : null;
      const land = () => {
        if (kind === "click") { ring.classList.remove("go"); void ring.offsetWidth; ring.classList.add("go"); }
        if (kind === "type") c.classList.add("typing");
        idle();
      };
      if (anim) anim.finished.then(land, () => {}); else land();
      return true;
    },
    pulse(kind) {
      if (!c.classList.contains("on")) return false;
      wake();
      if (kind === "type") c.classList.add("typing");
      idle();
      return true;
    },
    hide() { c.classList.add("hidden"); return true; },
    show() { c.classList.remove("hidden"); return true; },
    remove() { host.remove(); g.__crCursor = null; return true; }
  };
  return true;
})()`;

async function worldContext(tabId: number): Promise<number> {
  const cached = contexts.get(tabId);
  if (cached !== undefined) return cached;
  const tree = await send<{ frameTree: { frame: { id: string } } }>(tabId, "Page.getFrameTree");
  const world = await send<{ executionContextId: number }>(tabId, "Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: WORLD,
    grantUniveralAccess: false
  });
  contexts.set(tabId, world.executionContextId);
  return world.executionContextId;
}

async function evalInWorld(tabId: number, contextId: number, expression: string): Promise<unknown> {
  const r = await send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>(tabId, "Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

// Call a method on the installed cursor, installing it first when asked.
// A stale context id (document replaced) is retried once with a fresh one.
async function callCursor(tabId: number, call: string, install = false): Promise<unknown> {
  const expression = install
    ? `(${INSTALL}, globalThis.__crCursor.${call})`
    : `(globalThis.__crCursor ? globalThis.__crCursor.${call} : false)`;
  try {
    return await evalInWorld(tabId, await worldContext(tabId), expression);
  } catch {
    contexts.delete(tabId);
    if (!install) return false;
    return evalInWorld(tabId, await worldContext(tabId), expression);
  }
}

/** Glide the arrow to (x, y) in main-frame viewport coordinates. Best
 *  effort and fast: failures (a page we can't script, a closing tab) are
 *  swallowed — the arrow is never a reason for an action to fail. */
export async function moveCursor(tabId: number, x: number, y: number, kind: CursorKind): Promise<void> {
  if (!(await isCursorEnabled())) return;
  await callCursor(tabId, `move(${Math.round(x)}, ${Math.round(y)}, ${JSON.stringify(kind)})`, true).catch(() => {});
}

/** Acknowledge an action with no position of its own (keys): the arrow,
 *  if already on this page, stops thinking for a beat. */
export async function pulseCursor(tabId: number, kind: CursorKind): Promise<void> {
  if (!contexts.has(tabId) || !(await isCursorEnabled())) return;
  await callCursor(tabId, `pulse(${JSON.stringify(kind)})`).catch(() => {});
}

/** Hide the arrow around a screenshot (the agent wants the page, not our
 *  drawing). Returns the restore step; a no-op when no arrow was drawn. */
export async function hideCursorDuring<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  if (!contexts.has(tabId)) return fn();
  const hidden = (await callCursor(tabId, "hide()").catch(() => false)) === true;
  try {
    return await fn();
  } finally {
    if (hidden) await callCursor(tabId, "show()").catch(() => {});
  }
}
