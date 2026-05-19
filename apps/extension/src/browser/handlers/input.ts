// Trusted-input + JS-eval handlers:
//   CLICK, FILL, KEYBOARD, TYPE, EVALUATE

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
import { pressKey } from "../keyboard";
import { fillElement, focusSelector, locateForClick } from "../page-actions";
import { resolveTarget, requireTabId, type ToolHandler } from "./target";

export const inputHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.CLICK](args) {
    const parsed = parseChromeClickArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);

    // Resolve target coords. Selector mode looks the element up in-page
    // and scrolls it into view; coords mode trusts the caller's numbers
    // and dispatches at those pixels directly.
    let x: number, y: number;
    if (parsed.kind === "coords") {
      x = parsed.x;
      y = parsed.y;
    } else {
      const rect = await evalInTab(tabId, locateForClick, [parsed.selector]);
      x = rect.x;
      y = rect.y;
    }

    // Hover first — some pages (Material ripple, anti-bot heuristics) only register
    // clicks that follow a mouse move. Then a trusted press/release pair via CDP.
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x, y,
      button: "none",
      buttons: 0
    });
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x, y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x, y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });

    return {
      clicked: true,
      x, y,
      ...(parsed.kind === "selector" ? { selector: parsed.selector } : {})
    };
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
    const timeout = parsed.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    const expression = `(async () => { ${parsed.code} })()`;

    const result = await evalExpression(tabId, expression, {
      userGesture: true,
      timeout
    });

    return { tabId, result: result.value, type: result.type };
  }
};
