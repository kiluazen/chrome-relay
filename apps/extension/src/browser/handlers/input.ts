// Trusted-input + JS-eval handlers:
//   CLICK, FILL, KEYBOARD, TYPE, EVALUATE
//
// All element-addressed tools accept three modes (adoption-spec Change 2):
// @ref (from chrome_snapshot — carries its own tab), CSS selector, or
// coordinates. Ref mode NEVER falls back to the active tab: the ref's
// stored tabId is the target, and a contradicting --tab is target_conflict
// (enforced in resolveRefTarget).

import {
  DEFAULT_EVAL_TIMEOUT_MS,
  parseChromeClickArgs,
  parseChromeFillArgs,
  parseChromeKeyboardArgs,
  parseChromeTypeArgs,
  parseChromeEvaluateArgs,
  TOOL_NAMES
} from "@chrome-relay/protocol";
import { evalExpression, evalInTab, send } from "../cdp";
import { resolveRefCenter, resolveRefObjectId, mapPageError } from "../element";
import { pressKey } from "../keyboard";
import { fillElement, focusSelector, locateForClick } from "../page-actions";
import { resolveTarget, requireTabId, type ToolHandler } from "./target";

// Trusted CDP mouse click triple at (x, y).
//
// Hover first — some pages (Material ripple, anti-bot heuristics) only
// register clicks that follow a mouse move. pointerType: "mouse" is critical
// for modern UI libraries (Radix, React-Aria, Headless UI) that listen for
// `pointerdown` instead of `mousedown` — without it the page receives
// trusted mouse events but its pointer-event listeners never fire, so
// dropdowns / menu triggers stay closed. Failure mode is silent.
// Consequence reporting: did this click start a navigation? If yes, every
// ref in the tab just died (refs.ts invalidates on the loading event), and
// the agent should know NOW — in the click's own response — instead of one
// wasted stale_ref call later. Check immediately, then once more after
// 120ms (JS click handlers often navigate a tick later). Best effort.
async function detectNavigation(tabId: number, urlBefore: string | undefined): Promise<boolean> {
  const check = async (): Promise<boolean> => {
    try {
      const t = await chrome.tabs.get(tabId);
      return t.status === "loading" || (urlBefore !== undefined && t.url !== urlBefore);
    } catch {
      return false;
    }
  };
  if (await check()) return true;
  await new Promise((r) => setTimeout(r, 120));
  return check();
}

const NAVIGATED_NOTE =
  "click triggered a navigation — this tab's refs are now stale; re-run snapshot before the next ref action";

async function dispatchClick(tabId: number, x: number, y: number): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x, y,
    button: "none",
    buttons: 0,
    pointerType: "mouse"
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x, y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse"
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x, y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse"
  });
}

export const inputHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.CLICK](args) {
    const parsed = parseChromeClickArgs(args);

    if (parsed.kind === "ref") {
      // Ref mode — the ref's tab IS the target; resolveTarget (active-tab
      // default) is deliberately not consulted.
      const r = await resolveRefCenter(TOOL_NAMES.CLICK, parsed.ref, parsed);
      const urlBefore = (await chrome.tabs.get(r.tabId).catch(() => undefined))?.url;
      await dispatchClick(r.tabId, r.x, r.y);
      const navigated = await detectNavigation(r.tabId, urlBefore);
      return {
        clicked: true,
        x: r.x,
        y: r.y,
        ref: parsed.ref,
        tabId: r.tabId,
        ...(r.healed ? { healed: true } : {}),
        ...(navigated ? { navigated: true, note: NAVIGATED_NOTE } : {})
      };
    }

    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);

    let x: number, y: number;
    if (parsed.kind === "coords") {
      x = parsed.x;
      y = parsed.y;
    } else {
      try {
        const rect = await evalInTab(tabId, locateForClick, [parsed.selector]);
        x = rect.x;
        y = rect.y;
      } catch (e) {
        mapPageError(e, TOOL_NAMES.CLICK, "locate_element");
      }
    }

    const urlBefore = tab.url;
    await dispatchClick(tabId, x, y);
    const navigated = await detectNavigation(tabId, urlBefore);

    return {
      clicked: true,
      x, y,
      ...(parsed.kind === "selector" ? { selector: parsed.selector } : {}),
      ...(navigated ? { navigated: true, note: NAVIGATED_NOTE } : {})
    };
  },

  async [TOOL_NAMES.FILL](args) {
    const parsed = parseChromeFillArgs(args);

    if (parsed.kind === "ref") {
      const r = await resolveRefObjectId(TOOL_NAMES.FILL, parsed.ref, parsed);
      // Same semantics as the in-page fillElement, applied to the resolved
      // node: native prototype setter (bypasses React's value tracker so
      // onChange fires), then input + change events.
      const resp = await send<{
        result: { value?: unknown };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>(r.tabId, "Runtime.callFunctionOn", {
        objectId: r.objectId,
        functionDeclaration: `function (value) {
          const element = this;
          if (element instanceof HTMLSelectElement) {
            element.value = value;
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { filled: true, valueLength: value.length, kind: "select" };
          }
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
            throw new Error("Fill target is not an input, textarea, or select. Use chrome_type for contenteditable.");
          }
          element.focus();
          const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const nativeSet = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (nativeSet) { nativeSet.call(element, value); } else { element.value = value; }
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { filled: true, valueLength: value.length, kind: "input" };
        }`,
        arguments: [{ value: parsed.value }],
        returnByValue: true
      });
      if (resp.exceptionDetails) {
        mapPageError(
          new Error(resp.exceptionDetails.exception?.description ?? resp.exceptionDetails.text),
          TOOL_NAMES.FILL,
          "fill_ref"
        );
      }
      return {
        ...(resp.result.value as Record<string, unknown>),
        ref: parsed.ref,
        tabId: r.tabId,
        ...(r.healed ? { healed: true } : {})
      };
    }

    const tab = await resolveTarget(parsed);
    try {
      return await evalInTab(requireTabId(tab), fillElement, [parsed.selector, parsed.value]);
    } catch (e) {
      mapPageError(e, TOOL_NAMES.FILL, "fill_selector");
    }
  },

  async [TOOL_NAMES.KEYBOARD](args) {
    const parsed = parseChromeKeyboardArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    await pressKey(tabId, parsed.keys);
    return { sent: true, keys: parsed.keys };
  },

  async [TOOL_NAMES.TYPE](args) {
    const parsed = parseChromeTypeArgs(args);

    if (parsed.ref) {
      // Resolve + verify (and scroll into view), then trusted focus by
      // backendNodeId — no CSS round-trip. No hit-test: focusing a covered
      // element is legitimate (pointer never moves).
      const r = await resolveRefCenter(TOOL_NAMES.TYPE, parsed.ref, parsed, { hitTest: false });
      await send(r.tabId, "DOM.focus", { backendNodeId: r.backendNodeId });
      await send(r.tabId, "Input.insertText", { text: parsed.text });
      return {
        typed: true,
        length: parsed.text.length,
        focused: { ref: parsed.ref },
        tabId: r.tabId,
        ...(r.healed ? { healed: true } : {})
      };
    }

    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);

    let focused: { selector: string } | null = null;
    if (parsed.selector) {
      try {
        await evalInTab(tabId, focusSelector, [parsed.selector]);
      } catch (e) {
        mapPageError(e, TOOL_NAMES.TYPE, "focus_selector");
      }
      focused = { selector: parsed.selector };
    }

    await send(tabId, "Input.insertText", { text: parsed.text });

    return { typed: true, length: parsed.text.length, focused };
  },

  async [TOOL_NAMES.EVALUATE](args) {
    const parsed = parseChromeEvaluateArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    const timeout = parsed.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    const expression = `(async () => { ${parsed.code} })()`;

    const result = await evalExpression(tabId, expression, {
      userGesture: true,
      timeout
    });

    return { tabId, result: result.value, type: result.type };
  }
};
