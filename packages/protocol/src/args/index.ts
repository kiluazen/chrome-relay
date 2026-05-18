// Tool-arg parsers — protocol-owned single source of truth.
//
// Code-quality-hardening Risk 1: every tool's args go through one of these
// parsers at the extension's trust boundary (top of each handler). The
// CLI itself doesn't currently re-validate — it constructs the JSON via
// commander and forwards. That's a tradeoff: the parser fires at the
// extension, agents get RelayError(invalid_arguments) with structured
// fields back through the bridge, but bad CLI input pays one round-trip
// before failing. Future PR could move validation closer to the CLI.
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
