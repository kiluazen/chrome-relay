// Trusted-input + JS-eval handlers:
//   CLICK, FILL, KEYBOARD, TYPE, EVALUATE

import { TOOL_NAMES } from "@chrome-relay/protocol";
import { evalExpression, evalInTab, send } from "../cdp";
import { pressKey } from "../keyboard";
import { fillElement, focusSelector, locateForClick } from "../page-actions";
import { resolveTarget, requireTabId, invalidArg, type ToolHandler } from "./target";

export const inputHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.CLICK](args) {
    const selector = typeof args.selector === "string" ? args.selector : "";
    if (!selector) {
      invalidArg(TOOL_NAMES.CLICK, "chrome_click_element requires a selector.");
    }

    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);

    // Resolve the element's center in viewport CSS pixels and scroll it into view.
    const rect = await evalInTab(tabId, locateForClick, [selector]);

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

    return { clicked: true, selector, x: rect.x, y: rect.y };
  },

  async [TOOL_NAMES.FILL](args) {
    const selector = typeof args.selector === "string" ? args.selector : "";
    const value = typeof args.value === "string" ? args.value : "";
    if (!selector) {
      invalidArg(TOOL_NAMES.FILL, "chrome_fill_or_select requires a selector.");
    }

    const tab = await resolveTarget(args);
    return evalInTab(requireTabId(tab), fillElement, [selector, value]);
  },

  async [TOOL_NAMES.KEYBOARD](args) {
    const keys = typeof args.keys === "string" ? args.keys : "";
    if (!keys) {
      invalidArg(TOOL_NAMES.KEYBOARD, "chrome_keyboard requires keys.");
    }

    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    await pressKey(tabId, keys);
    return { sent: true, keys };
  },

  async [TOOL_NAMES.TYPE](args) {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text) {
      invalidArg(TOOL_NAMES.TYPE, "chrome_type requires text.");
    }

    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);

    let focused: { selector: string } | null = null;
    if (typeof args.selector === "string" && args.selector) {
      await evalInTab(tabId, focusSelector, [args.selector]);
      focused = { selector: args.selector };
    }

    await send(tabId, "Input.insertText", { text });

    return { typed: true, length: text.length, focused };
  },

  async [TOOL_NAMES.EVALUATE](args) {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code) {
      invalidArg(TOOL_NAMES.EVALUATE, "chrome_evaluate requires code.");
    }

    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : 15_000;
    const expression = `(async () => { ${code} })()`;

    const result = await evalExpression(tabId, expression, {
      userGesture: true,
      timeout
    });

    return { tabId, result: result.value, type: result.type };
  }
};
