export const NATIVE_HOST_NAME = "dev.chrome_relay.native_host";
export const DEFAULT_HTTP_PORT = 12122;
export const CHROME_WEB_STORE_EXTENSION_ID = "cpdiapbifblhlcpnmlmfpgfjlacebokb";
export const LEGACY_DEV_EXTENSION_ID = "cdmmkpadhnpcfjljhgpdnnljhjafmhop";
export const LOCAL_UNPACKED_EXTENSION_ID = "cleiodnaklknhhfopegimjelfibjmbkc";
export const DEFAULT_EXTENSION_ID = CHROME_WEB_STORE_EXTENSION_ID;
export const DEFAULT_EXTENSION_IDS = [
  CHROME_WEB_STORE_EXTENSION_ID,
  LEGACY_DEV_EXTENSION_ID,
  LOCAL_UNPACKED_EXTENSION_ID
];

export const TOOL_NAMES = {
  GET_WINDOWS_AND_TABS: "get_windows_and_tabs",
  NAVIGATE: "chrome_navigate",
  SWITCH_TAB: "chrome_switch_tab",
  CLOSE_TABS: "chrome_close_tabs",
  SCREENSHOT: "chrome_screenshot",
  READ_PAGE: "chrome_read_page",
  CLICK: "chrome_click_element",
  FILL: "chrome_fill_or_select",
  KEYBOARD: "chrome_keyboard",
  TYPE: "chrome_type",
  EVALUATE: "chrome_evaluate",
  // §2.2 — viewport emulation (set/preset/clear share one tool, action via args.action)
  VIEWPORT: "chrome_viewport",
  // chrome_self_reload — calls chrome.runtime.reload() inside the extension.
  // Lets the dev loop refresh the extension without manually clicking reload
  // on chrome://extensions (Chrome blocks CDP attach on chrome:// pages).
  SELF_RELOAD: "chrome_self_reload",
  // §2.7c — console capture. Ring-buffer per tab; actions read/clear via args.
  CONSOLE: "chrome_console",
  // Workspaces — named Chrome windows for parallel agent work. Single tool
  // with action: create | list | close. Every existing tool also accepts an
  // optional workspaceName arg that routes ops into that workspace's window.
  // (Was "chrome_group" pre-0.4.0; renamed because "group" collides with
  // Chrome's own tab-group UI primitive, which is now exposed separately.)
  WORKSPACE: "chrome_workspace",
  // Tab groups — Chrome's native colored, collapsible folder of tabs inside
  // a single window. Single tool with action: create | list | close | add | remove.
  // Every existing tool also accepts an optional groupName arg that routes
  // ops to a tab inside that tab-group.
  GROUP: "chrome_group",
  // §2.4 — accessibility tree. ~30× smaller than DOM serialization, more
  // semantic. click_ax pairs with it: targets by backendDOMNodeId, no CSS.
  AX: "chrome_ax",
  CLICK_AX: "chrome_click_ax",
  // §2.7a — network capture. Ring-buffer per tab; actions read/clear/har/body.
  NETWORK: "chrome_network",
  // Hover — dispatches mouseMoved at element center (or x,y) so :hover/
  // :focus-within styles fire before a click or screencast frame is read.
  HOVER: "chrome_hover",
  // Screencast — wraps CDP Page.startScreencast / stopScreencast. SW buffers
  // base64 JPEG frames per tab between start and stop. Paint-driven (catches
  // CSS transitions, fade-ins, focus-ring motion) — at the cost of requiring
  // the tab to be ACTIVE (Chrome doesn't paint backgrounded tabs). See
  // docs/recording.md for the active-tab matrix.
  SCREENCAST: "chrome_screencast"
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export type ToolArguments = Record<string, unknown>;

export interface LocalBridgeCallRequest {
  name: ToolName;
  args?: ToolArguments;
}

export type BridgeResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export interface BridgeReadyMessage {
  type: "bridge.ready";
  payload: {
    extensionId: string;
    version: string;
  };
}

export interface BridgePingMessage {
  type: "bridge.ping";
  id: string;
}

export interface BridgePongMessage {
  type: "bridge.pong";
  id: string;
}

export interface ToolCallMessage {
  type: "tool.call";
  id: string;
  payload: {
    name: ToolName;
    args: ToolArguments;
  };
}

export interface ToolResultMessage {
  type: "tool.result";
  id: string;
  payload: BridgeResponse;
}

export type BridgeMessage =
  | BridgeReadyMessage
  | BridgePingMessage
  | BridgePongMessage
  | ToolCallMessage
  | ToolResultMessage;
