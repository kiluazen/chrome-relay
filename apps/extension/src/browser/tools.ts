import { TOOL_NAMES, type ToolArguments, type ToolName } from "@chrome-relay/protocol";
import { evalExpression, evalInTab, send } from "./cdp";
import { pressKey } from "./keyboard";
import {
  fillElement,
  focusSelector,
  locateForClick,
  readPageSnapshot
} from "./page-actions";
import { VIEWPORT_PRESETS, isPresetName, listPresets } from "./viewport-presets";

type ToolHandler = (args: ToolArguments) => Promise<unknown>;

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

async function getTargetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (typeof tabId === "number") {
    return chrome.tabs.get(tabId);
  }
  return getActiveTab();
}

function requireTabId(tab: chrome.tabs.Tab): number {
  if (typeof tab.id !== "number") {
    throw new Error("Target tab has no tab ID.");
  }
  return tab.id;
}

const handlers: Record<ToolName, ToolHandler> = {
  async [TOOL_NAMES.GET_WINDOWS_AND_TABS]() {
    const windows = await chrome.windows.getAll({ populate: true });
    return {
      windowCount: windows.length,
      tabCount: windows.reduce((count, current) => count + (current.tabs?.length ?? 0), 0),
      windows: windows.map((window) => ({
        windowId: window.id,
        focused: window.focused,
        tabs: (window.tabs ?? []).map((tab) => ({
          tabId: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          active: tab.active
        }))
      }))
    };
  },

  async [TOOL_NAMES.NAVIGATE](args) {
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) {
      throw new Error("chrome_navigate requires a url.");
    }

    const newTab = args.newTab === true;
    const active = args.active !== false;

    if (newTab) {
      const tab = await chrome.tabs.create({ url, active });
      return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
    }

    const current = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
    const tabId = requireTabId(current);

    await send(tabId, "Page.navigate", { url });
    if (active) {
      await chrome.tabs.update(tabId, { active: true });
    }

    return { tabId, windowId: current.windowId, url };
  },

  async [TOOL_NAMES.SWITCH_TAB](args) {
    const tabId = Number(args.tabId);
    if (!Number.isFinite(tabId)) {
      throw new Error("chrome_switch_tab requires a numeric tabId.");
    }

    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
    return { tabId: tab.id, windowId: tab.windowId, active: true };
  },

  async [TOOL_NAMES.CLOSE_TABS](args) {
    const tabIds = Array.isArray(args.tabIds) ? args.tabIds.map((value) => Number(value)) : [];
    if (tabIds.length === 0 || tabIds.some((value) => !Number.isFinite(value))) {
      throw new Error("chrome_close_tabs requires a numeric tabIds array.");
    }

    await chrome.tabs.remove(tabIds);
    return { closedTabIds: tabIds };
  },

  async [TOOL_NAMES.SCREENSHOT](args) {
    const tab = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
    const tabId = requireTabId(tab);
    const fullPage = args.fullPage === true;

    // §2.3 — region screenshots. Three input shapes (in priority order):
    //   args.bbox     = "x,y,w,h"  → explicit rect
    //   args.selector = "<css>"    → element bbox (in-page getBoundingClientRect)
    //   neither                    → full viewport or full page (existing behavior)
    //
    // Big agent value: a header-only screenshot is ~10× cheaper than a full
    // tab capture in both bytes and the LLM's per-image token cost.
    const params: Record<string, unknown> = {
      format: "png",
      captureBeyondViewport: fullPage
    };

    let clipMeta: { source: "bbox" | "selector"; selector?: string; padding?: number } | null = null;

    if (typeof args.bbox === "string") {
      const clip = parseBbox(args.bbox);
      params.clip = clip;
      // Explicit bbox overrides fullPage — caller is being specific.
      params.captureBeyondViewport = true;
      clipMeta = { source: "bbox" };
    } else if (typeof args.selector === "string" && args.selector) {
      const padding = typeof args.padding === "number" ? args.padding : 0;
      const rect = await evalInTab(tabId, locateForClick, [args.selector]);
      // locateForClick gives center+size; convert to a top-left+w+h clip with padding.
      const clip = {
        x: Math.max(0, rect.x - rect.width / 2 - padding),
        y: Math.max(0, rect.y - rect.height / 2 - padding),
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
        scale: 1
      };
      params.clip = clip;
      params.captureBeyondViewport = true;
      clipMeta = { source: "selector", selector: args.selector, padding };
    }

    const result = await send<{ data: string }>(tabId, "Page.captureScreenshot", params);

    return {
      tabId,
      windowId: tab.windowId,
      dataUrl: `data:image/png;base64,${result.data}`,
      ...(clipMeta ? { clip: clipMeta } : {})
    };
  },

  async [TOOL_NAMES.READ_PAGE](args) {
    const tab = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
    const tabId = requireTabId(tab);
    return evalInTab(tabId, readPageSnapshot, [args.interactiveOnly === true]);
  },

  async [TOOL_NAMES.CLICK](args) {
    const selector = typeof args.selector === "string" ? args.selector : "";
    if (!selector) {
      throw new Error("chrome_click_element requires a selector.");
    }

    const tab = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
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
      throw new Error("chrome_fill_or_select requires a selector.");
    }

    const tab = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
    return evalInTab(requireTabId(tab), fillElement, [selector, value]);
  },

  async [TOOL_NAMES.KEYBOARD](args) {
    const keys = typeof args.keys === "string" ? args.keys : "";
    if (!keys) {
      throw new Error("chrome_keyboard requires keys.");
    }

    const tab = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
    const tabId = requireTabId(tab);
    await pressKey(tabId, keys);
    return { sent: true, keys };
  },

  async [TOOL_NAMES.TYPE](args) {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text) {
      throw new Error("chrome_type requires text.");
    }

    const tab = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
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
      throw new Error("chrome_evaluate requires code.");
    }

    const tab = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
    const tabId = requireTabId(tab);
    const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : 15_000;
    const expression = `(async () => { ${code} })()`;

    const result = await evalExpression(tabId, expression, {
      userGesture: true,
      timeout
    });

    return { tabId, result: result.value, type: result.type };
  },

  // §2.2 — viewport emulation. Single tool with three actions:
  //   action=set    width/height/dpr/mobile/hasTouch (+ optional userAgent)
  //   action=preset name  → resolve from viewport-presets table, apply
  //   action=clear  → drop the override
  //   action=list   → enumerate preset names (no CDP call)
  //
  // Override survives navigations within the tab but is wiped on debugger
  // detach. Closing the tab clears it. Living with that — the alternative
  // (re-apply on every CDP attach) is a much bigger lifecycle commitment.
  async [TOOL_NAMES.VIEWPORT](args) {
    const action = typeof args.action === "string" ? args.action : "set";

    if (action === "list") {
      return { presets: listPresets() };
    }

    const tab = await getTargetTab(typeof args.tabId === "number" ? args.tabId : undefined);
    const tabId = requireTabId(tab);

    if (action === "clear") {
      await send(tabId, "Emulation.clearDeviceMetricsOverride", {});
      await send(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
      // No "clearUserAgentOverride" — passing empty userAgent resets.
      await send(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
      return { tabId, cleared: true };
    }

    let spec: { width: number; height: number; dpr: number; mobile: boolean; hasTouch: boolean; userAgent?: string };
    let presetName: string | null = null;

    if (action === "preset") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!isPresetName(name)) {
        throw new Error(`Unknown preset "${name}". Available: ${listPresets().join(", ")}`);
      }
      spec = VIEWPORT_PRESETS[name];
      presetName = name;
    } else if (action === "set") {
      const width  = Number(args.width);
      const height = Number(args.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("chrome_viewport set requires positive numeric width and height.");
      }
      spec = {
        width,
        height,
        dpr: Number.isFinite(Number(args.dpr)) ? Number(args.dpr) : 1,
        mobile: args.mobile === true,
        hasTouch: args.hasTouch === true || args.mobile === true,
        userAgent: typeof args.userAgent === "string" ? args.userAgent : undefined
      };
    } else {
      throw new Error(`chrome_viewport: unknown action "${action}". Expected set | preset | clear | list.`);
    }

    await send(tabId, "Emulation.setDeviceMetricsOverride", {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: spec.dpr,
      mobile: spec.mobile,
      screenWidth: spec.width,
      screenHeight: spec.height,
      positionX: 0,
      positionY: 0,
      dontSetVisibleSize: false,
      screenOrientation: spec.mobile
        ? { type: "portraitPrimary", angle: 0 }
        : { type: "landscapePrimary", angle: 0 }
    });
    await send(tabId, "Emulation.setTouchEmulationEnabled", {
      enabled: spec.hasTouch,
      maxTouchPoints: spec.hasTouch ? 1 : 0
    });
    if (spec.userAgent) {
      await send(tabId, "Emulation.setUserAgentOverride", { userAgent: spec.userAgent });
    }

    return {
      tabId,
      applied: {
        width: spec.width,
        height: spec.height,
        dpr: spec.dpr,
        mobile: spec.mobile,
        hasTouch: spec.hasTouch,
        userAgent: spec.userAgent ?? null,
        preset: presetName
      }
    };
  }
};

// Parse "x,y,w,h" → CDP clip object. Strict: rejects negative or non-numeric.
function parseBbox(spec: string): { x: number; y: number; width: number; height: number; scale: number } {
  const parts = spec.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`Invalid --bbox "${spec}". Expected x,y,width,height (positive numbers).`);
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3], scale: 1 };
}

export async function runTool(name: ToolName, args: ToolArguments): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unsupported tool: ${name}`);
  }

  return handler(args);
}
