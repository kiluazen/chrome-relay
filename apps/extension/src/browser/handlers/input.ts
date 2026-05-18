// Trusted-input + JS-eval handlers:
//   CLICK, FILL, KEYBOARD, TYPE, EVALUATE

import {
  parseChromeClickArgs,
  parseChromeFillArgs,
  parseChromeKeyboardArgs,
  parseChromeTypeArgs,
  parseChromeEvaluateArgs,
  TOOL_NAMES
} from "@chrome-relay/protocol";
import { evalExpression, evalInTab, send } from "../cdp";
import { pressKey } from "../keyboard";
import { fillElement, focusSelector, locateForClick } from "../page-actions";
import { resolveTarget, requireTabId, type ToolHandler } from "./target";

export const inputHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.CLICK](args) {
    const parsed = parseChromeClickArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);

    // Resolve the element's center in viewport CSS pixels and scroll it into view.
    const rect = await evalInTab(tabId, locateForClick, [parsed.selector]);

    // Hover first — some pages (Material ripple, anti-bot heuristics) only register
    // clicks that follow a mouse move. Then a trusted press/release pair via CDP.
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x,
      y: rect.y,
      button: "none",
      buttons: 0
    });
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: rect.x,
      y: rect.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: rect.x,
      y: rect.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });

    return { clicked: true, selector: parsed.selector, x: rect.x, y: rect.y };
  },

  async [TOOL_NAMES.FILL](args) {
    const parsed = parseChromeFillArgs(args);
    const tab = await resolveTarget(parsed);
    return evalInTab(requireTabId(tab), fillElement, [parsed.selector, parsed.value]);
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
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);

    let focused: { selector: string } | null = null;
    if (parsed.selector) {
      await evalInTab(tabId, focusSelector, [parsed.selector]);
      focused = { selector: parsed.selector };
    }

    await send(tabId, "Input.insertText", { text: parsed.text });

    return { typed: true, length: parsed.text.length, focused };
  },

  async [TOOL_NAMES.EVALUATE](args) {
    const parsed = parseChromeEvaluateArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    const timeout = parsed.timeoutMs ?? 15_000;
    const expression = `(async () => { ${parsed.code} })()`;

    const result = await evalExpression(tabId, expression, {
      userGesture: true,
      timeout
    });

    return { tabId, result: result.value, type: result.type };
  }
};
