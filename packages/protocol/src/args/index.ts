// Tool-arg parsers — protocol-owned single source of truth.
//
// Code-quality-hardening Risk 1: every tool's args go through one of these
// parsers at the extension's trust boundary (top of each handler). The CLI
// also calls parseToolArgs() before forwarding known tools to the bridge, so
// bad command input fails locally with the same structured RelayError.
//
// Coverage: every tool in TOOL_NAMES is covered.
//   navigate.ts   chrome_navigate
//   hover.ts      chrome_hover
//   network.ts    chrome_network
//   simple.ts     chrome_read_page, click, fill, keyboard, type, evaluate,
//                 switch_tab, close_tabs, ax, click_ax, screenshot,
//                 get_windows_and_tabs, self_reload
//   multi.ts      chrome_viewport, console, workspace, group, screencast
//
// Parsers reject "present but wrong type" with code:invalid_arguments. A
// field that's truly omitted (undefined or null) is OK; the handler uses
// its default.

export * from "./shared";
export * from "./navigate";
export * from "./hover";
export * from "./network";
export * from "./simple";
export * from "./multi";

import type { ToolName } from "../index";
import {
  parseChromeNavigateArgs,
  type ChromeNavigateArgs
} from "./navigate";
import {
  parseChromeHoverArgs,
  type ChromeHoverArgs
} from "./hover";
import {
  parseChromeNetworkArgs,
  type ChromeNetworkArgs
} from "./network";
import {
  parseGetWindowsAndTabsArgs,
  parseChromeSelfReloadArgs,
  parseChromeReadPageArgs,
  parseChromeClickArgs,
  parseChromeFillArgs,
  parseChromeKeyboardArgs,
  parseChromeTypeArgs,
  parseChromeEvaluateArgs,
  parseChromeSwitchTabArgs,
  parseChromeCloseTabsArgs,
  parseChromeAxArgs,
  parseChromeClickAxArgs,
  parseChromeScreenshotArgs,
  type NoArgs,
  type ChromeReadPageArgs,
  type ChromeClickArgs,
  type ChromeFillArgs,
  type ChromeKeyboardArgs,
  type ChromeTypeArgs,
  type ChromeEvaluateArgs,
  type ChromeSwitchTabArgs,
  type ChromeCloseTabsArgs,
  type ChromeAxArgs,
  type ChromeClickAxArgs,
  type ChromeScreenshotArgs
} from "./simple";
import {
  parseChromeViewportArgs,
  parseChromeConsoleArgs,
  parseChromeWorkspaceArgs,
  parseChromeGroupArgs,
  parseChromeScreencastArgs,
  type ChromeViewportArgs,
  type ChromeConsoleArgs,
  type ChromeWorkspaceArgs,
  type ChromeGroupArgs,
  type ChromeScreencastArgs
} from "./multi";

export interface ToolArgMap {
  get_windows_and_tabs: NoArgs;
  chrome_navigate: ChromeNavigateArgs;
  chrome_switch_tab: ChromeSwitchTabArgs;
  chrome_close_tabs: ChromeCloseTabsArgs;
  chrome_screenshot: ChromeScreenshotArgs;
  chrome_read_page: ChromeReadPageArgs;
  chrome_click_element: ChromeClickArgs;
  chrome_fill_or_select: ChromeFillArgs;
  chrome_keyboard: ChromeKeyboardArgs;
  chrome_type: ChromeTypeArgs;
  chrome_evaluate: ChromeEvaluateArgs;
  chrome_viewport: ChromeViewportArgs;
  chrome_self_reload: NoArgs;
  chrome_console: ChromeConsoleArgs;
  chrome_workspace: ChromeWorkspaceArgs;
  chrome_group: ChromeGroupArgs;
  chrome_ax: ChromeAxArgs;
  chrome_click_ax: ChromeClickAxArgs;
  chrome_network: ChromeNetworkArgs;
  chrome_hover: ChromeHoverArgs;
  chrome_screencast: ChromeScreencastArgs;
}

export type ParsedToolArguments<T extends ToolName = ToolName> = ToolArgMap[T];

export function parseToolArgs<T extends ToolName>(name: T, input: unknown): ToolArgMap[T] {
  switch (name) {
    case "get_windows_and_tabs": return parseGetWindowsAndTabsArgs(input) as ToolArgMap[T];
    case "chrome_navigate": return parseChromeNavigateArgs(input) as ToolArgMap[T];
    case "chrome_switch_tab": return parseChromeSwitchTabArgs(input) as ToolArgMap[T];
    case "chrome_close_tabs": return parseChromeCloseTabsArgs(input) as ToolArgMap[T];
    case "chrome_screenshot": return parseChromeScreenshotArgs(input) as ToolArgMap[T];
    case "chrome_read_page": return parseChromeReadPageArgs(input) as ToolArgMap[T];
    case "chrome_click_element": return parseChromeClickArgs(input) as ToolArgMap[T];
    case "chrome_fill_or_select": return parseChromeFillArgs(input) as ToolArgMap[T];
    case "chrome_keyboard": return parseChromeKeyboardArgs(input) as ToolArgMap[T];
    case "chrome_type": return parseChromeTypeArgs(input) as ToolArgMap[T];
    case "chrome_evaluate": return parseChromeEvaluateArgs(input) as ToolArgMap[T];
    case "chrome_viewport": return parseChromeViewportArgs(input) as ToolArgMap[T];
    case "chrome_self_reload": return parseChromeSelfReloadArgs(input) as ToolArgMap[T];
    case "chrome_console": return parseChromeConsoleArgs(input) as ToolArgMap[T];
    case "chrome_workspace": return parseChromeWorkspaceArgs(input) as ToolArgMap[T];
    case "chrome_group": return parseChromeGroupArgs(input) as ToolArgMap[T];
    case "chrome_ax": return parseChromeAxArgs(input) as ToolArgMap[T];
    case "chrome_click_ax": return parseChromeClickAxArgs(input) as ToolArgMap[T];
    case "chrome_network": return parseChromeNetworkArgs(input) as ToolArgMap[T];
    case "chrome_hover": return parseChromeHoverArgs(input) as ToolArgMap[T];
    case "chrome_screencast": return parseChromeScreencastArgs(input) as ToolArgMap[T];
  }
  const exhaustive: never = name;
  return exhaustive;
}
