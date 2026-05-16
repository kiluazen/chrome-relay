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
  EVALUATE: "chrome_evaluate"
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
