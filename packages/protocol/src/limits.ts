// Shared numeric limits and defaults.
//
// Why this file: the same magic numbers used to live in multiple places
// (ring sizes in the buffer modules, body-preview length in the handler,
// CLI help text describing the limit). When one changed, the others
// silently drifted. Centralizing here means the docs + handlers + tests
// can all import from one source.
//
// Naming: each constant ends with its unit (`_MS`, `_BYTES`, `_ENTRIES`).
// `DEFAULT_` for the value the system uses absent explicit override;
// `MAX_` for hard ceilings that can't be raised by an argument.

// ---------------------------------------------------------------------------
// Bridge timeouts (CLI → native host)

/** Default timeout for a single tool call before the bridge gives up. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;
/** Timeout for ping/pong handshake. Short — pings should be near-instant. */
export const DEFAULT_PING_TIMEOUT_MS = 2_000;
/** Max time the CLI waits for the extension's bridge.ready before failing. */
export const DEFAULT_READY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Per-tool defaults

/** chrome_evaluate timeout when caller omits timeoutMs. */
export const DEFAULT_EVAL_TIMEOUT_MS = 15_000;

/** chrome_network body: default head-bytes when neither --head nor --full set. */
export const DEFAULT_BODY_PREVIEW_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Per-tab capture buffer ceilings

/** Network ring buffer: max entries per tab. Oldest are dropped. */
export const NETWORK_BUFFER_MAX_ENTRIES = 200;
/** Network ring buffer: max bytes per tab (metadata only; bodies not stored). */
export const NETWORK_BUFFER_MAX_BYTES = 512 * 1024;

/** Console ring buffer: max entries per tab. */
export const CONSOLE_BUFFER_MAX_ENTRIES = 200;
/** Console ring buffer: max bytes per tab. */
export const CONSOLE_BUFFER_MAX_BYTES = 256 * 1024;
/** Per-entry text length cap (truncated when exceeded). */
export const CONSOLE_ENTRY_TEXT_MAX_CHARS = 1000;
/** Per-entry stack-trace length cap. */
export const CONSOLE_ENTRY_STACK_MAX_CHARS = 1000;
