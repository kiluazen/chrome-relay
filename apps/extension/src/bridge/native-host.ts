import type {
  BridgeMessage,
  BridgePingMessage,
  ToolCallMessage,
  ToolResultMessage
} from "@chrome-relay/protocol";
import { NATIVE_HOST_NAME, toBridgeError } from "@chrome-relay/protocol";
import { runTool } from "../browser/tools";

const RECONNECT_DELAY_MS = 1500;
const RECENT_TOOLS_STORAGE_KEY = "recentToolExecutions";
const RECENT_TOOLS_LIMIT = 3;

let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

type RecentToolExecution = {
  id: string;
  name: string;
  at: string;
  ok: boolean;
  summary: string;
};

const state = {
  connected: false,
  extensionId: chrome.runtime.id,
  nativeHostName: NATIVE_HOST_NAME,
  cliHint: "chrome-relay tabs",
  lastError: "",
  recentToolExecutions: [] as RecentToolExecution[]
};

function short(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function summarizeArgs(message: ToolCallMessage): string {
  const args = message.payload.args;
  const tab = typeof args.tabId === "number" ? `tab ${args.tabId}` : "active tab";

  switch (message.payload.name) {
    case "get_windows_and_tabs":
      return "list windows and tabs";
    case "chrome_navigate":
      return `navigate ${short(String(args.url ?? ""))}${args.newTab ? " in new tab" : ""}`;
    case "chrome_switch_tab":
      return `switch to tab ${String(args.tabId ?? "")}`;
    case "chrome_close_tabs":
      return `close tabs ${Array.isArray(args.tabIds) ? args.tabIds.join(", ") : ""}`;
    case "chrome_screenshot":
      return `screenshot ${tab}${args.fullPage ? " full page" : ""}`;
    case "chrome_read_page":
      return `read ${tab}${args.interactiveOnly ? " interactive elements" : ""}`;
    case "chrome_click_element":
      return `click ${short(String(args.selector ?? ""))} on ${tab}`;
    case "chrome_fill_or_select":
      return `fill ${short(String(args.selector ?? ""))} on ${tab} (${String(args.value ?? "").length} chars)`;
    case "chrome_keyboard":
      return `keys ${short(String(args.keys ?? ""))} on ${tab}`;
    default:
      return message.payload.name;
  }
}

async function loadRecentToolExecutions(): Promise<void> {
  const stored = await chrome.storage.local.get(RECENT_TOOLS_STORAGE_KEY);
  const value = stored[RECENT_TOOLS_STORAGE_KEY];
  if (Array.isArray(value)) {
    state.recentToolExecutions = value.slice(0, RECENT_TOOLS_LIMIT) as RecentToolExecution[];
  }
}

function recordToolExecution(message: ToolCallMessage, ok: boolean, error?: unknown): void {
  const execution: RecentToolExecution = {
    id: message.id,
    name: message.payload.name,
    at: new Date().toISOString(),
    ok,
    summary: error ? `${summarizeArgs(message)} — ${error instanceof Error ? error.message : String(error)}` : summarizeArgs(message)
  };

  state.recentToolExecutions = [
    execution,
    ...state.recentToolExecutions
  ].slice(0, RECENT_TOOLS_LIMIT);

  void chrome.storage.local.set({
    [RECENT_TOOLS_STORAGE_KEY]: state.recentToolExecutions
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

async function handleToolCall(message: ToolCallMessage): Promise<void> {
  if (!port) {
    return;
  }

  try {
    const data = await runTool(message.payload.name, message.payload.args);
    recordToolExecution(message, true);
    const response: ToolResultMessage = {
      type: "tool.result",
      id: message.id,
      payload: { ok: true, data }
    };
    port.postMessage(response);
  } catch (error) {
    recordToolExecution(message, false, error);
    // Structured BridgeError preserved alongside the legacy string for
    // backwards compat. Native bridge + CLI both forward both shapes.
    const errorDetails = toBridgeError(error, message.payload.name);
    const response: ToolResultMessage = {
      type: "tool.result",
      id: message.id,
      payload: {
        ok: false,
        error: errorDetails.message,
        errorDetails
      }
    };
    port.postMessage(response);
  }
}

function handleMessage(message: BridgeMessage): void {
  if (!port) {
    return;
  }

  if (message.type === "bridge.ping") {
    const ping = message as BridgePingMessage;
    port.postMessage({ type: "bridge.pong", id: ping.id });
    return;
  }

  if (message.type === "tool.call") {
    void handleToolCall(message);
  }
}

function connect(): void {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    state.connected = true;
    state.lastError = "";
  } catch (error) {
    console.warn("[Chrome Relay] Failed to connect native host:", error);
    state.connected = false;
    state.lastError = error instanceof Error ? error.message : String(error);
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      console.warn("[Chrome Relay] Native host disconnected:", chrome.runtime.lastError.message);
      state.lastError = chrome.runtime.lastError.message ?? "Native host disconnected.";
    }
    port = null;
    state.connected = false;
    scheduleReconnect();
  });

  port.postMessage({
    type: "bridge.ready",
    payload: {
      extensionId: chrome.runtime.id,
      version: chrome.runtime.getManifest().version
    }
  });
}

export function startNativeBridge(): void {
  void loadRecentToolExecutions();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "chrome-relay.status") {
      sendResponse(state);
    }
  });

  connect();
}
