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

// ---------------------------------------------------------------------------
// Structured errors + notices (code-quality-hardening PR 1).
//
// Why: a string error loses code-able context. An agent that gets
// `"Element not found for selector ..."` has to regex-match the message to
// decide whether to retry. With a code, the agent can branch mechanically.
//
// Backwards compatibility: the wire shape carries BOTH the legacy string
// fields (`error: string`, `notice: string`) AND the new structured fields
// (`errorDetails: BridgeError`, `notices: BridgeNotice[]`). Old clients
// keep working. Structured fields will be the only shape in a future major
// version; the string fields will be removed then.

export type BridgeErrorCode =
  | "invalid_arguments"
  | "unsupported_tool"
  | "target_not_found"
  | "target_conflict"
  | "element_not_found"
  | "cdp_error"
  | "chrome_api_error"
  | "timeout"
  | "native_host_disconnected"
  | "extension_not_connected"
  | "external_dependency_missing"
  | "partial_success_disallowed"
  | "internal_error";

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  tool?: ToolName;
  phase?: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

export type BridgeNoticeCode =
  | "cli_outdated"
  | "extension_outdated"
  | "target_overridden"
  | "deprecated";

export interface BridgeNotice {
  code: BridgeNoticeCode;
  message: string;
  details?: Record<string, unknown>;
  action?: {
    command: string;
  };
}

export type BridgeResponse<T = unknown> =
  | { ok: true; data: T; notice?: string; notices?: BridgeNotice[] }
  | { ok: false; error: string; errorDetails?: BridgeError; notice?: string; notices?: BridgeNotice[] };

// RelayError — thrown inside handlers; serialized to BridgeError at the
// trust boundary. Both the extension and the native host use this; the
// receiving end deserializes back into structured form.
export class RelayError extends Error {
  readonly code: BridgeErrorCode;
  readonly tool?: ToolName;
  readonly phase?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable?: boolean;

  constructor(spec: BridgeError) {
    super(spec.message);
    this.name = "RelayError";
    this.code = spec.code;
    this.tool = spec.tool;
    this.phase = spec.phase;
    this.details = spec.details;
    this.retryable = spec.retryable;
  }

  toBridgeError(): BridgeError {
    return {
      code: this.code,
      message: this.message,
      ...(this.tool ? { tool: this.tool } : {}),
      ...(this.phase ? { phase: this.phase } : {}),
      ...(this.details ? { details: this.details } : {}),
      ...(this.retryable !== undefined ? { retryable: this.retryable } : {})
    };
  }
}

// Helper for boundaries that catch unknown throws. RelayError preserves
// itself; anything else becomes `internal_error` with the raw message.
export function toBridgeError(unknownErr: unknown, fallbackTool?: ToolName): BridgeError {
  if (unknownErr instanceof RelayError) {
    const e = unknownErr.toBridgeError();
    return fallbackTool && !e.tool ? { ...e, tool: fallbackTool } : e;
  }
  const message = unknownErr instanceof Error ? unknownErr.message : String(unknownErr);
  return {
    code: "internal_error",
    message,
    ...(fallbackTool ? { tool: fallbackTool } : {})
  };
}

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
