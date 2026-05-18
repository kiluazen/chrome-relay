// Session + capture-buffer handlers:
//   VIEWPORT, SELF_RELOAD, WORKSPACE, GROUP, CONSOLE, NETWORK

import {
  DEFAULT_BODY_PREVIEW_BYTES,
  parseChromeConsoleArgs,
  parseChromeGroupArgs,
  parseChromeNetworkArgs,
  parseChromeSelfReloadArgs,
  parseChromeViewportArgs,
  parseChromeWorkspaceArgs,
  RelayError,
  TOOL_NAMES
} from "@chrome-relay/protocol";
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
import { resolveTarget, requireTabId, invalidArg, type ToolHandler } from "./target";

export const sessionsHandlers: Partial<Record<string, ToolHandler>> = {
  // §2.2 — viewport emulation. Single tool with three actions:
  //   action=set    width/height/dpr/mobile/hasTouch (+ optional userAgent)
  //   action=preset name  → resolve from viewport-presets table, apply
  //   action=clear  → drop the override
  //   action=list   → enumerate preset names (no CDP call)
  async [TOOL_NAMES.VIEWPORT](args) {
    const parsed = parseChromeViewportArgs(args);

    if (parsed.action === "list") {
      return { presets: listPresets() };
    }

    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);

    if (parsed.action === "clear") {
      await send(tabId, "Emulation.clearDeviceMetricsOverride", {});
      await send(tabId, "Emulation.setTouchEmulationEnabled", { enabled: false });
      await send(tabId, "Emulation.setUserAgentOverride", { userAgent: "" });
      return { tabId, cleared: true };
    }

    let spec: { width: number; height: number; dpr: number; mobile: boolean; hasTouch: boolean; userAgent?: string };
    let presetName: string | null = null;

    if (parsed.action === "preset") {
      if (!isPresetName(parsed.name)) {
        invalidArg(
          TOOL_NAMES.VIEWPORT,
          `Unknown preset "${parsed.name}". Available: ${listPresets().join(", ")}`,
          "parse_preset_name",
          { received: parsed.name, validChoices: listPresets() }
        );
      }
      spec = VIEWPORT_PRESETS[parsed.name];
      presetName = parsed.name;
    } else {
      // parsed.action === "set" — width/height already validated as positive numbers.
      spec = {
        width:    parsed.width,
        height:   parsed.height,
        dpr:      parsed.dpr ?? 1,
        mobile:   parsed.mobile === true,
        hasTouch: parsed.hasTouch === true || parsed.mobile === true,
        userAgent: parsed.userAgent
      };
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
  async [TOOL_NAMES.SELF_RELOAD](args) {
    parseChromeSelfReloadArgs(args);
    // Defer slightly so this tool call's response makes it back to the
    // bridge before the SW dies. 100ms is plenty in practice.
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloaded: true, note: "Extension service worker will restart momentarily." };
  },

  // Workspaces — named Chrome windows for parallel agent work.
  async [TOOL_NAMES.WORKSPACE](args) {
    const parsed = parseChromeWorkspaceArgs(args);
    if (parsed.action === "create") {
      return createWorkspace(parsed.name, { url: parsed.url, label: parsed.label });
    }
    if (parsed.action === "list") {
      const workspaces = await listWorkspaces();
      return { workspaces, count: workspaces.length };
    }
    // parsed.action === "close"
    return closeWorkspace(parsed.name);
  },

  // Tab groups — Chrome's native colored, collapsible folder inside one
  // window.
  async [TOOL_NAMES.GROUP](args) {
    const parsed = parseChromeGroupArgs(args);

    if (parsed.action === "create") {
      return createTabGroup(parsed.name, {
        tabIds: parsed.tabIds,
        color: parsed.color,
        collapsed: parsed.collapsed,
        windowId: parsed.windowId
      });
    }
    if (parsed.action === "list") {
      const groups = await listTabGroups();
      return { groups, count: groups.length };
    }
    if (parsed.action === "close") {
      return closeTabGroup(parsed.name);
    }
    if (parsed.action === "add") {
      return addToTabGroup(parsed.name, parsed.tabIds);
    }
    // parsed.action === "remove"
    return removeFromTabGroup(parsed.tabIds);
  },

  // §2.7c — console capture. First call on a tab subscribes; subsequent
  // calls are fast reads from the in-memory ring buffer.
  async [TOOL_NAMES.CONSOLE](args) {
    const parsed = parseChromeConsoleArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);

    if (parsed.action === "clear") {
      return clearConsole(tabId);
    }
    // parsed.action === "read"
    await ensureConsoleCapture(tabId);
    return readConsole(tabId, { levels: parsed.levels, since: parsed.since, limit: parsed.limit });
  },

  // §2.7a — network capture. action: read | clear | har | body.
  async [TOOL_NAMES.NETWORK](args) {
    const parsed = parseChromeNetworkArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);

    if (parsed.action === "clear") return clearNetwork(tabId);

    await ensureNetworkCapture(tabId);

    if (parsed.action === "body") {
      const result = await getBody(tabId, parsed.requestId);
      const full = parsed.full === true;
      const head = parsed.head ?? (full ? Infinity : DEFAULT_BODY_PREVIEW_BYTES);
      const truncated = result.body.length > head;
      return {
        body: truncated ? result.body.slice(0, head) : result.body,
        base64Encoded: result.base64Encoded,
        truncated,
        totalBytes: result.body.length,
        ...(truncated ? { hint: "pass --full to get the entire body" } : {})
      };
    }

    if (parsed.action === "har") {
      return buildHar(
        tabId,
        { filter: parsed.filter, status: parsed.status, method: parsed.method, limit: parsed.limit },
        parsed.withBodies === true,
        parsed.bestEffortBodies === true
      );
    }
    // parsed.action === "read"
    return readNetwork(tabId, { filter: parsed.filter, status: parsed.status, method: parsed.method, limit: parsed.limit });
  }
};
