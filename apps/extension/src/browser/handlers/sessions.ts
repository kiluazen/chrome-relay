// Session + capture-buffer handlers:
//   VIEWPORT, SELF_RELOAD, WORKSPACE, GROUP, CONSOLE, NETWORK

import { RelayError, TOOL_NAMES } from "@chrome-relay/protocol";
import { send } from "../cdp";
import { VIEWPORT_PRESETS, isPresetName, listPresets } from "../viewport-presets";
import {
  createWorkspace,
  listWorkspaces,
  closeWorkspace
} from "../workspaces";
import {
  createTabGroup,
  listTabGroups,
  closeTabGroup,
  addToTabGroup,
  removeFromTabGroup
} from "../tab-groups";
import {
  ensureConsoleCapture,
  readConsole,
  clearConsole
} from "../console-buffer";
import {
  ensureNetworkCapture,
  readNetwork,
  getBody,
  clearNetwork,
  buildHar
} from "../network-buffer";
import {
  parseTabIds,
  parseTabGroupColor,
  parseLevels,
  parseNetworkStatus
} from "../parsers";
import { resolveTarget, requireTabId, invalidArg, type ToolHandler } from "./target";

export const sessionsHandlers: Partial<Record<string, ToolHandler>> = {
  // §2.2 — viewport emulation. Single tool with three actions:
  //   action=set    width/height/dpr/mobile/hasTouch (+ optional userAgent)
  //   action=preset name  → resolve from viewport-presets table, apply
  //   action=clear  → drop the override
  //   action=list   → enumerate preset names (no CDP call)
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
      await send(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
      return { tabId, cleared: true };
    }

    let spec: { width: number; height: number; dpr: number; mobile: boolean; hasTouch: boolean; userAgent?: string };
    let presetName: string | null = null;

    if (action === "preset") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!isPresetName(name)) {
        invalidArg(
          TOOL_NAMES.VIEWPORT,
          `Unknown preset "${name}". Available: ${listPresets().join(", ")}`,
          "parse_preset_name",
          { received: name, validChoices: listPresets() }
        );
      }
      spec = VIEWPORT_PRESETS[name];
      presetName = name;
    } else if (action === "set") {
      const width  = Number(args.width);
      const height = Number(args.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        invalidArg(
          TOOL_NAMES.VIEWPORT,
          "chrome_viewport set requires positive numeric width and height.",
          "parse_dimensions",
          { received: { width: args.width, height: args.height } }
        );
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
    // disabling touch, omit the field.
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
  // chrome.runtime.reload(). Workaround for Chrome's CDP block on
  // chrome:// pages: we can't drive the "reload" button on
  // chrome://extensions via debugger.attach, but the extension can
  // self-reload from inside.
  async [TOOL_NAMES.SELF_RELOAD]() {
    // Defer slightly so this tool call's response makes it back to the
    // bridge before the SW dies. 100ms is plenty in practice.
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloaded: true, note: "Extension service worker will restart momentarily." };
  },

  // Workspaces — named Chrome windows for parallel agent work.
  async [TOOL_NAMES.WORKSPACE](args) {
    const action = typeof args.action === "string" ? args.action : "list";
    if (action === "create") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) invalidArg(TOOL_NAMES.WORKSPACE, "chrome_workspace create requires a name.");
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
      if (!name) invalidArg(TOOL_NAMES.WORKSPACE, "chrome_workspace close requires a name.");
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
  // window.
  async [TOOL_NAMES.GROUP](args) {
    const action = typeof args.action === "string" ? args.action : "list";

    if (action === "create") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) invalidArg(TOOL_NAMES.GROUP, "chrome_group create requires a name.");
      const tabIds = parseTabIds(args.tabIds);
      if (tabIds.length === 0) {
        invalidArg(TOOL_NAMES.GROUP, "chrome_group create requires at least one tabId (--tabs 1,2,3).");
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
      if (!name) invalidArg(TOOL_NAMES.GROUP, "chrome_group close requires a name.");
      return closeTabGroup(name);
    }
    if (action === "add") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) invalidArg(TOOL_NAMES.GROUP, "chrome_group add requires a name.");
      const tabIds = parseTabIds(args.tabIds);
      if (tabIds.length === 0) invalidArg(TOOL_NAMES.GROUP, "chrome_group add requires --tabs <ids>.");
      return addToTabGroup(name, tabIds);
    }
    if (action === "remove") {
      const tabIds = parseTabIds(args.tabIds);
      if (tabIds.length === 0) invalidArg(TOOL_NAMES.GROUP, "chrome_group remove requires --tabs <ids>.");
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

  // §2.7c — console capture. First call on a tab subscribes; subsequent
  // calls are fast reads from the in-memory ring buffer.
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

    await ensureConsoleCapture(tabId);

    const levels = parseLevels(args.levels);
    const since  = typeof args.since === "number" ? args.since : undefined;
    const limit  = typeof args.limit === "number" ? args.limit : undefined;
    return readConsole(tabId, { levels, since, limit });
  },

  // §2.7a — network capture. action: read | clear | har | body.
  async [TOOL_NAMES.NETWORK](args) {
    const tab = await resolveTarget(args);
    const tabId = requireTabId(tab);
    const action = typeof args.action === "string" ? args.action : "read";

    if (action === "clear") return clearNetwork(tabId);

    await ensureNetworkCapture(tabId);

    if (action === "body") {
      const requestId = typeof args.requestId === "string" ? args.requestId : "";
      if (!requestId) invalidArg(TOOL_NAMES.NETWORK, "chrome_network body requires --request-id.", "parse_arguments");
      const result = await getBody(tabId, requestId);
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
