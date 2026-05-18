// Tool-arg parsers — protocol-owned single source of truth.
//
// Code-quality-hardening Risk 1: every tool's args go through one of these
// parsers. Both CLI (when constructing outgoing args) and extension (at
// the trust boundary, top of each handler) consume the same parser, so
// silent shape drift between them is structurally impossible.
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
