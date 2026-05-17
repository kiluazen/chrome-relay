import { RelayError, TOOL_NAMES, type ToolArguments, type ToolName } from "@chrome-relay/protocol";
import { evalExpression, evalInTab, send } from "./cdp";
import { pressKey } from "./keyboard";
import {
  fillElement,
  focusSelector,
  locateForClick,
  readPageSnapshot
} from "./page-actions";
import { VIEWPORT_PRESETS, isPresetName, listPresets } from "./viewport-presets";
import {
  ensureConsoleCapture,
  readConsole,
  clearConsole,
  type ConsoleLevel
} from "./console-buffer";
import {
  createWorkspace,
  listWorkspaces,
  closeWorkspace,
  resolveWorkspaceTarget
} from "./workspaces";
import {
  createTabGroup,
  listTabGroups,
  closeTabGroup,
  addToTabGroup,
  removeFromTabGroup,
  resolveTabGroupTarget,
  type TabGroupColor
} from "./tab-groups";
import { getAxTree, clickAxNode } from "./a11y";
import {
  parseTabIds,
  parseTabGroupColor,
  parseLevels,
  parseNetworkStatus
} from "./parsers";
import {
  ensureNetworkCapture,
  readNetwork,
  getBody,
  clearNetwork,
  buildHar
} from "./network-buffer";
import { startScreencast, stopScreencast } from "./screencast";

type ToolHandler = (args: ToolArguments) => Promise<unknown>;

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

// Target-tab resolver. Precedence (most → least specific):
//   1. explicit tabId — `--tab N` wins over everything else
//   2. groupName     — `--group X` picks the active tab inside tab-group X
//                      (Chrome's native colored folder)
//   3. workspaceName — `--workspace W` picks the active tab inside the
//                      named window W
//   4. active tab in current window — no flag given
//
// If multiple flags are passed, the higher-precedence one wins silently
// (mirrors the pre-existing "tab wins" contract). Tab-groups live inside
// one window anyway, so passing both --group and --workspace would usually
// be redundant; we let --group win since it's more specific.
async function resolveTarget(args: {
  tabId?: unknown;
  groupName?: unknown;
  workspaceName?: unknown;
}): Promise<chrome.tabs.Tab> {
  if (typeof args.tabId === "number") {
    return chrome.tabs.get(args.tabId);
  }
  if (typeof args.groupName === "string" && args.groupName) {
    return resolveTabGroupTarget(args.groupName);
  }
  if (typeof args.workspaceName === "string" && args.workspaceName) {
    return resolveWorkspaceTarget(args.workspaceName);
  }
  return getActiveTab();
}

// Compatibility shim — existing call sites still pass a bare number. New
// callers use resolveTarget(args). Eventually we can remove this and
// migrate every handler, but no need to touch the world right now.
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
      throw new RelayError({
        code: "invalid_arguments",
        message: "chrome_navigate requires a url.",
        tool: TOOL_NAMES.NAVIGATE,
        phase: "parse_arguments",
        retryable: false
      });
    }

    const newTab = args.newTab === true;
    const active = args.active !== false;
    // Opt-in flag: when true, restores the pre-0.5.5 silent best-effort
    // behavior for windowId resolution + group-join — failures degrade
    // to "tab landed somewhere, group not joined" instead of erroring.
    // Default is strict (PR 3 of code-quality-hardening).
    const allowPartial = args.allowPartial === true;

    if (newTab) {
      // Route the new tab into the right window. Without this,
      // chrome.tabs.create drops the tab into whichever window happens to
      // be focused — which, for a user with their own Chrome session up,
      // is theirs (not the agent's workspace window). Pre-0.4.0 this
      // manifested as `--group X navigate --new` sending tabs into the
      // user's own window instead of group X's. Same logic applies now to
      // --workspace W and --group G.
      const createOpts: chrome.tabs.CreateProperties = { url, active };
      let joinTabGroupName: string | undefined;
      if (typeof args.tabId === "number" || typeof args.tabId === "string") {
        const numeric = Number(args.tabId);
        if (!Number.isFinite(numeric)) {
          throw new RelayError({
            code: "invalid_arguments",
            message: `chrome_navigate: invalid tabId ${JSON.stringify(args.tabId)}. Expected a number.`,
            tool: TOOL_NAMES.NAVIGATE,
            phase: "resolve_reference_tab",
            details: { received: args.tabId },
            retryable: false
          });
        }
        try {
          const ref = await chrome.tabs.get(numeric);
          if (typeof ref.windowId === "number") createOpts.windowId = ref.windowId;
        } catch (e) {
          // Strict: if the agent named a specific reference tab and that
          // tab doesn't exist, the routing intent can't be honored. Failing
          // here prevents the new tab from silently landing in the user's
          // focused window. Pass allowPartial: true to fall back to
          // "wherever Chrome picks" with a warning in the result.
          if (!allowPartial) {
            throw new RelayError({
              code: "target_not_found",
              message: `chrome_navigate: reference tab ${numeric} not found; refusing to silently route to a different window. Re-run with allowPartial: true to let Chrome pick.`,
              tool: TOOL_NAMES.NAVIGATE,
              phase: "resolve_reference_tab",
              details: { tabId: numeric, underlying: e instanceof Error ? e.message : String(e) },
              retryable: false
            });
          }
        }
      } else if (typeof args.groupName === "string" && args.groupName) {
        // A tab-group lives inside one window; route the new tab to that
        // window AND remember to join the group after creation. If the
        // group doesn't exist resolveTabGroupTarget throws — that already
        // fails loudly today.
        const groupTab = await resolveTabGroupTarget(args.groupName);
        if (typeof groupTab.windowId === "number") createOpts.windowId = groupTab.windowId;
        joinTabGroupName = args.groupName;
      } else if (typeof args.workspaceName === "string" && args.workspaceName) {
        const wsTab = await resolveWorkspaceTarget(args.workspaceName);
        if (typeof wsTab.windowId === "number") createOpts.windowId = wsTab.windowId;
      }
      const tab = await chrome.tabs.create(createOpts);
      const warnings: Array<{ code: string; message: string }> = [];
      if (joinTabGroupName && typeof tab.id === "number") {
        try {
          await addToTabGroup(joinTabGroupName, [tab.id]);
        } catch (e) {
          // Strict by default: a `navigate --new --group G` that creates
          // the tab but fails to join G is a partial success — the agent
          // wanted both. Surfacing the failure prevents downstream code
          // from operating on the tab assuming it's inside the group.
          // allowPartial:true falls back to the legacy behavior (warning
          // attached to the success result, no error).
          if (!allowPartial) {
            throw new RelayError({
              code: "partial_success_disallowed",
              message: `chrome_navigate: created tab ${tab.id} but failed to add it to group ${joinTabGroupName}. Pass allowPartial: true to keep the tab and emit a warning instead.`,
              tool: TOOL_NAMES.NAVIGATE,
              phase: "join_tab_group",
              details: {
                createdTabId: tab.id,
                groupName: joinTabGroupName,
                underlying: e instanceof Error ? e.message : String(e)
              },
              retryable: false
            });
          }
          warnings.push({
            code: "group_join_failed",
            message: `Tab ${tab.id} was created but could not be added to group ${joinTabGroupName}.`
          });
        }
      }
      const result: Record<string, unknown> = { tabId: tab.id, windowId: tab.windowId, url: tab.url };
      if (warnings.length > 0) {
        result.partial = true;
        result.warnings = warnings;
      }
      return result;
    }

    const current = await resolveTarget(args);
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
    const tab = await resolveTarget(args);
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

    // #2 — optional downscale via OffscreenCanvas. Agents under image-size caps
    // (most multimodal APIs limit to ~2000 px on the longer edge) can pass
    // --max-edge to keep mobile-DPR captures under the limit without doing a
    // post-process step on their side. No default — full fidelity stays opt-out.
    let outData = result.data;
    let downscaled: { from: { width: number; height: number }; to: { width: number; height: number } } | null = null;
    if (typeof args.maxEdge === "number" && args.maxEdge > 0) {
      const ds = await downscalePngToMaxEdge(result.data, args.maxEdge);
      outData = ds.data;
      if (ds.from.width !== ds.to.width || ds.from.height !== ds.to.height) {
        downscaled = { from: ds.from, to: ds.to };
      }
    }

    return {
      tabId,
      windowId: tab.windowId,
      dataUrl: `data:image/png;base64,${outData}`,
      ...(clipMeta ? { clip: clipMeta } : {}),
      ...(downscaled ? { downscaled } : {})
    };
  },

  async [TOOL_NAMES.READ_PAGE](args) {
    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    return evalInTab(tabId, readPageSnapshot, [args.interactiveOnly === true]);
  },

  async [TOOL_NAMES.CLICK](args) {
    const selector = typeof args.selector === "string" ? args.selector : "";
    if (!selector) {
      throw new Error("chrome_click_element requires a selector.");
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
      throw new Error("chrome_fill_or_select requires a selector.");
    }

    const tab = await resolveTarget(args);
    return evalInTab(requireTabId(tab), fillElement, [selector, value]);
  },

  async [TOOL_NAMES.KEYBOARD](args) {
    const keys = typeof args.keys === "string" ? args.keys : "";
    if (!keys) {
      throw new Error("chrome_keyboard requires keys.");
    }

    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    await pressKey(tabId, keys);
    return { sent: true, keys };
  },

  async [TOOL_NAMES.TYPE](args) {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text) {
      throw new Error("chrome_type requires text.");
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
      throw new Error("chrome_evaluate requires code.");
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

    const tab = await resolveTarget(args);
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
      throw new RelayError({
        code: "invalid_arguments",
        message: `chrome_viewport: unknown action "${action}". Expected set | preset | clear | list.`,
        tool: TOOL_NAMES.VIEWPORT,
        phase: "parse_action",
        details: { received: action, validChoices: ["set", "preset", "clear", "list"] },
        retryable: false
      });
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
    // CDP rejects maxTouchPoints: 0 ("must be between 1 and 16"). When
    // disabling touch, omit the field — `enabled: false` alone is valid.
    await send(tabId, "Emulation.setTouchEmulationEnabled",
      spec.hasTouch
        ? { enabled: true, maxTouchPoints: 1 }
        : { enabled: false }
    );
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
  },

  // chrome_self_reload — restart the extension service worker via
  // chrome.runtime.reload(). New code (after rebuild) takes effect on the
  // NEXT message that goes through the bridge. Returns immediately; the SW
  // will tear down shortly after.
  //
  // Workaround for Chrome's CDP block on chrome:// pages: we can't drive the
  // "reload" button on chrome://extensions via debugger.attach, but the
  // extension can self-reload from inside. No-arg.
  async [TOOL_NAMES.SELF_RELOAD]() {
    // Defer slightly so this tool call's response makes it back to the bridge
    // before the SW dies. 100ms is plenty in practice.
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloaded: true, note: "Extension service worker will restart momentarily." };
  },

  // §2.4 — accessibility tree. Returns a compact, semantic alternative to
  // chrome_read_page. Each node carries backendDOMNodeId (`id`) which
  // chrome_click_ax uses to click without needing a CSS selector.
  async [TOOL_NAMES.AX](args) {
    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    return getAxTree(tabId, {
      interactiveOnly: args.interactiveOnly === true,
      rootRole: typeof args.rootRole === "string" ? args.rootRole : undefined,
      includeSubframes: args.includeSubframes === true
    });
  },

  async [TOOL_NAMES.CLICK_AX](args) {
    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    const node = Number(args.node ?? args.id);
    if (!Number.isFinite(node) || node <= 0) {
      throw new Error("chrome_click_ax requires --node <backendDOMNodeId> (a positive integer from `chrome-relay ax`).");
    }
    return clickAxNode(tabId, node);
  },

  // Workspaces — named Chrome windows for parallel agent work. Single tool
  // with action: create | list | close. (Was chrome_group pre-0.4.0;
  // renamed when tab-groups became a distinct primitive.)
  async [TOOL_NAMES.WORKSPACE](args) {
    const action = typeof args.action === "string" ? args.action : "list";
    if (action === "create") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) throw new Error("chrome_workspace create requires a name.");
      const url = typeof args.url === "string" ? args.url : undefined;
      const label = typeof args.label === "string" ? args.label : undefined;
      return createWorkspace(name, { url, label });
    }
    if (action === "list") {
      const workspaces = await listWorkspaces();
      return { workspaces, count: workspaces.length };
    }
    if (action === "close") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) throw new Error("chrome_workspace close requires a name.");
      return closeWorkspace(name);
    }
    throw new RelayError({
      code: "invalid_arguments",
      message: `chrome_workspace: unknown action "${action}". Expected create | list | close.`,
      tool: TOOL_NAMES.WORKSPACE,
      phase: "parse_action",
      details: { received: action, validChoices: ["create", "list", "close"] },
      retryable: false
    });
  },

  // Tab groups — Chrome's native colored, collapsible folder inside one
  // window. Actions: create | list | close | add | remove. `--group X` on
  // any other command targets the active tab inside this tab-group.
  async [TOOL_NAMES.GROUP](args) {
    const action = typeof args.action === "string" ? args.action : "list";

    if (action === "create") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) throw new Error("chrome_group create requires a name.");
      const tabIds = parseTabIds(args.tabIds);
      if (tabIds.length === 0) {
        throw new Error("chrome_group create requires at least one tabId (--tabs 1,2,3).");
      }
      const color = parseTabGroupColor(args.color);
      const collapsed = typeof args.collapsed === "boolean" ? args.collapsed : undefined;
      const windowId = typeof args.windowId === "number" ? args.windowId : undefined;
      return createTabGroup(name, { tabIds, color, collapsed, windowId });
    }
    if (action === "list") {
      const groups = await listTabGroups();
      return { groups, count: groups.length };
    }
    if (action === "close") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) throw new Error("chrome_group close requires a name.");
      return closeTabGroup(name);
    }
    if (action === "add") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) throw new Error("chrome_group add requires a name.");
      const tabIds = parseTabIds(args.tabIds);
      if (tabIds.length === 0) throw new Error("chrome_group add requires --tabs <ids>.");
      return addToTabGroup(name, tabIds);
    }
    if (action === "remove") {
      const tabIds = parseTabIds(args.tabIds);
      if (tabIds.length === 0) throw new Error("chrome_group remove requires --tabs <ids>.");
      return removeFromTabGroup(tabIds);
    }
    throw new RelayError({
      code: "invalid_arguments",
      message: `chrome_group: unknown action "${action}". Expected create | list | close | add | remove.`,
      tool: TOOL_NAMES.GROUP,
      phase: "parse_action",
      details: { received: action, validChoices: ["create", "list", "close", "add", "remove"] },
      retryable: false
    });
  },

  // Hover — dispatches mouseMoved at element center so :hover/:focus-within
  // styles fire. Pair with screencast to capture micro-state animations
  // that the existing click path skips over.
  async [TOOL_NAMES.HOVER](args) {
    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    let x: number | undefined;
    let y: number | undefined;
    if (typeof args.x === "number" && typeof args.y === "number") {
      x = args.x;
      y = args.y;
    } else if (typeof args.selector === "string" && args.selector) {
      // Resolve to element center via page eval — same mechanism click uses.
      const result = await evalExpression<{ x: number; y: number; w: number; h: number } | null>(
        tabId,
        `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`
      );
      const rect = result.value;
      if (!rect) throw new Error(`chrome_hover: no element matches selector ${args.selector}`);
      x = rect.x + rect.w / 2;
      y = rect.y + rect.h / 2;
    } else {
      throw new Error("chrome_hover requires either --selector or --x and --y.");
    }
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      modifiers: 0,
      buttons: 0
    });
    return { hovered: true, x, y, selector: args.selector ?? null };
  },

  // Screencast — start/stop a CDP screencast stream. Frames are buffered
  // in the SW and returned on stop. Works on backgrounded tabs (the whole
  // point — Page.captureScreenshot doesn't).
  async [TOOL_NAMES.SCREENCAST](args) {
    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    const action = typeof args.action === "string" ? args.action : "start";
    if (action === "start") {
      const opts: Parameters<typeof startScreencast>[1] = {};
      // Strict format: undefined/null → default jpeg; anything else must be
      // one of the two supported values.
      if (args.format !== undefined && args.format !== null) {
        if (args.format !== "png" && args.format !== "jpeg") {
          throw new RelayError({
            code: "invalid_arguments",
            message: `chrome_screencast: invalid format ${JSON.stringify(args.format)}. Expected "jpeg" or "png".`,
            tool: TOOL_NAMES.SCREENCAST,
            phase: "parse_format",
            details: { received: args.format, validChoices: ["jpeg", "png"] },
            retryable: false
          });
        }
        opts.format = args.format;
      }
      if (typeof args.quality === "number")       opts.quality = args.quality;
      if (typeof args.maxWidth === "number")      opts.maxWidth = args.maxWidth;
      if (typeof args.maxHeight === "number")     opts.maxHeight = args.maxHeight;
      if (typeof args.everyNthFrame === "number") opts.everyNthFrame = args.everyNthFrame;
      return startScreencast(tabId, opts);
    }
    if (action === "stop") {
      return stopScreencast(tabId);
    }
    throw new RelayError({
      code: "invalid_arguments",
      message: `chrome_screencast: unknown action "${action}". Expected start | stop.`,
      tool: TOOL_NAMES.SCREENCAST,
      phase: "parse_action",
      details: { received: action, validChoices: ["start", "stop"] },
      retryable: false
    });
  },

  // §2.7c — console capture. First call on a tab subscribes; subsequent calls
  // are fast reads from the in-memory ring buffer. Actions:
  //   read   (default) → return entries [+ optional level/since/limit filter]
  //   clear            → wipe the buffer
  async [TOOL_NAMES.CONSOLE](args) {
    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    const action = typeof args.action === "string" ? args.action : "read";

    if (action === "clear") {
      return clearConsole(tabId);
    }
    if (action !== "read") {
      throw new RelayError({
        code: "invalid_arguments",
        message: `chrome_console: unknown action "${action}". Expected read | clear.`,
        tool: TOOL_NAMES.CONSOLE,
        phase: "parse_action",
        details: { received: action, validChoices: ["read", "clear"] },
        retryable: false
      });
    }

    // Subscribe first call (cheap idempotent on subsequent calls).
    await ensureConsoleCapture(tabId);

    const levels = parseLevels(args.levels);
    const since  = typeof args.since === "number" ? args.since : undefined;
    const limit  = typeof args.limit === "number" ? args.limit : undefined;
    return readConsole(tabId, { levels, since, limit });
  },

  // §2.7a — network capture. First call on a tab subscribes; subsequent calls
  // are reads from the in-memory ring. action: read | clear | har | body.
  async [TOOL_NAMES.NETWORK](args) {
    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    const action = typeof args.action === "string" ? args.action : "read";

    if (action === "clear") return clearNetwork(tabId);

    await ensureNetworkCapture(tabId);

    if (action === "body") {
      const requestId = typeof args.requestId === "string" ? args.requestId : "";
      if (!requestId) throw new Error("chrome_network body requires --request-id.");
      const result = await getBody(tabId, requestId);
      // §5 — default truncate to 8KB head to keep agent contexts manageable.
      // --full bypasses; --head <bytes> caps explicitly.
      const full = args.full === true;
      const head = typeof args.head === "number" ? args.head : (full ? Infinity : 8 * 1024);
      const truncated = result.body.length > head;
      return {
        body: truncated ? result.body.slice(0, head) : result.body,
        base64Encoded: result.base64Encoded,
        truncated,
        totalBytes: result.body.length,
        ...(truncated ? { hint: "pass --full to get the entire body" } : {})
      };
    }

    const filter = typeof args.filter === "string" ? args.filter : undefined;
    const status = parseNetworkStatus(args.status);
    const method = typeof args.method === "string" ? args.method : undefined;
    const limit  = typeof args.limit === "number" ? args.limit : undefined;

    if (action === "har") {
      const withBodies = args.withBodies === true;
      const bestEffortBodies = args.bestEffortBodies === true;
      return buildHar(tabId, { filter, status, method, limit }, withBodies, bestEffortBodies);
    }
    if (action !== "read") {
      throw new RelayError({
        code: "invalid_arguments",
        message: `chrome_network: unknown action "${action}". Expected read | clear | har | body.`,
        tool: TOOL_NAMES.NETWORK,
        phase: "parse_action",
        details: { received: action, validChoices: ["read", "clear", "har", "body"] },
        retryable: false
      });
    }
    return readNetwork(tabId, { filter, status, method, limit });
  }
};


// Downscale a base64 PNG so its longer edge ≤ maxEdge. Uses OffscreenCanvas
// (available in MV3 service workers). Returns the original bytes unchanged
// if the image is already within the limit.
async function downscalePngToMaxEdge(
  base64Png: string,
  maxEdge: number
): Promise<{ data: string; from: { width: number; height: number }; to: { width: number; height: number } }> {
  const binary = atob(base64Png);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const fromW = bitmap.width, fromH = bitmap.height;
  const longer = Math.max(fromW, fromH);
  if (longer <= maxEdge) {
    bitmap.close();
    return { data: base64Png, from: { width: fromW, height: fromH }, to: { width: fromW, height: fromH } };
  }
  const scale = maxEdge / longer;
  const toW = Math.max(1, Math.round(fromW * scale));
  const toH = Math.max(1, Math.round(fromH * scale));
  const canvas = new OffscreenCanvas(toW, toH);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("OffscreenCanvas 2d context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, toW, toH);
  bitmap.close();
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const outBuf = await outBlob.arrayBuffer();
  const outBytes = new Uint8Array(outBuf);
  // btoa(String.fromCharCode(...bytes)) — chunked to avoid call-stack overflow
  let outBin = "";
  for (let i = 0; i < outBytes.length; i += 8192) {
    outBin += String.fromCharCode.apply(null, Array.from(outBytes.subarray(i, i + 8192)));
  }
  return { data: btoa(outBin), from: { width: fromW, height: fromH }, to: { width: toW, height: toH } };
}

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
    throw new RelayError({
      code: "unsupported_tool",
      message: `Unsupported tool: ${name}`,
      details: { received: name },
      retryable: false
    });
  }

  return handler(args);
}
