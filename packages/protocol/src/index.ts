// Re-export the tool-arg parser surface (code-quality-hardening PR 12).
export * from "./args/index";
// Re-export shared numeric limits + defaults.
export * from "./limits";
// Snapshot wire types + the canonical text renderer (adoption-spec Change 1).
export * from "./snapshot";

export const NATIVE_HOST_NAME = "dev.chrome_relay.native_host";
export const DEFAULT_HTTP_PORT = 12122;
// Wire-protocol version, echoed by /ping and written into instance
// descriptors. Bump on breaking changes to the bridge/HTTP contract.
// v2 = multi-profile (registry discovery, qualified refs, profile stamp).
export const PROTOCOL_VERSION = 2;
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
  SCREENCAST: "chrome_screencast",
  // Unified page snapshot (adoption-spec Change 1) — AX tree + cursor-
  // interactive sweep, one ref space, compact text rendered CLI-side.
  // Supersedes chrome_read_page and chrome_ax, which now alias to it.
  SNAPSHOT: "chrome_snapshot",
  // Adoption-spec Change 3 — block until a condition holds (selector/@ref
  // visible, text present, URL glob, load state, JS truthy).
  WAIT: "chrome_wait",
  // Adoption-spec Change 5 — run N tool calls in one round-trip,
  // sequentially, bail-on-error by default. Amortizes CLI startup + the
  // HTTP/native-messaging hop.
  BATCH: "chrome_batch",
  // Adoption-spec Change 6 — one value (text/value/attr/count/title/url)
  // without paying for a full snapshot.
  GET: "chrome_get",
  // File upload — three strategies as actions (set/choose/drop), mirroring
  // the click-strategy taxonomy: each mechanism has its own failure mode,
  // the agent picks, no auto-fallback. All strategies take file PATHS;
  // Chrome reads the files itself, nothing crosses the bridge.
  UPLOAD: "chrome_upload"
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export type ToolArguments = Record<string, unknown>;

export interface LocalBridgeCallRequest {
  name: ToolName;
  args?: ToolArguments;
}

// ---------------------------------------------------------------------------
// Target selector (code-quality-hardening PR 2).
//
// Currently the wire still carries `tabId`, `workspaceName`, and `groupName`
// as three loose fields in ToolArguments — that's existing behavior and the
// extension keeps reading them. TargetSelector is the *intended* shape:
// exactly one of "active" | "tab" | "workspace" | "group" per call. Future
// PRs migrate the wire to a single `target` field that the extension
// resolves.
//
// CLI enforces the conflict rules today (see packages/cli/src/program.ts
// baseArgs()) so the loose fields on the wire are guaranteed to obey them
// when produced by the CLI. Third-party callers POSTing directly to
// /call still bear the responsibility — until the extension also enforces
// in a later PR.

export type TargetSelector =
  | { kind: "active" }
  | { kind: "tab"; tabId: number }
  | { kind: "workspace"; name: string }
  | { kind: "group"; name: string };

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
  // A @ref from a previous snapshot no longer resolves — the node is gone
  // and the role/name/nth heal found no replacement. Fix: re-run snapshot.
  | "stale_ref"
  // The ref resolved, but a hit-test found an unrelated element (overlay,
  // sticky header, modal) owning the click point. We refuse to click
  // through it; details name the intercepting element.
  | "click_intercepted"
  | "cdp_error"
  | "chrome_api_error"
  | "timeout"
  | "native_host_disconnected"
  | "extension_not_connected"
  | "external_dependency_missing"
  | "partial_success_disallowed"
  // --- multi-profile routing (v2) ---
  // Two+ profiles connected and the call carried no profile scope, or a
  // --profile / ref-prefix matched more than one instance. details.candidates
  // enumerates {instanceId, label, email?} so the agent can retry scoped.
  | "profile_ambiguous"
  // --profile or a qualified-ref prefix matched no connected instance.
  // details.connected lists what IS reachable.
  | "profile_not_found"
  // `profile label` with a name already bound to a different instanceId.
  | "label_conflict"
  // --- file upload (v2) ---
  // upload set: the resolved node is not an <input type="file">. Try
  // `upload choose` on the visible trigger instead.
  | "not_a_file_input"
  // upload choose: the click landed but no file chooser opened within the
  // timeout — wrong trigger, or the site uses a drop zone.
  | "no_file_chooser"
  // upload choose: another choose is already armed on this tab. Interception
  // is serialized per tab; retry after it settles.
  | "file_chooser_busy"
  // upload choose: a chooser opened but this strategy can't drive it (no
  // backendNodeId — non-input-backed chooser, or OOPIF in v1).
  | "file_chooser_unsupported"
  // Chrome's "Allow access to file URLs" toggle is off for the extension;
  // debugger file operations are gated on it. details carry remediation.
  | "file_access_denied"
  // More files passed than the input accepts (single-file input, or
  // chooser mode selectSingle).
  | "multiple_not_supported"
  // A --file path did not stat locally. Fails CLI-side before the wire.
  | "file_not_found"
  // /call carried a missing/wrong bearer token. Means the descriptor the
  // client routed by is stale — re-discover via the instance registry.
  | "unauthorized"
  // The target tab navigated or closed while an operation was armed.
  | "target_closed"
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
  // upload: the target input's `accept` attribute doesn't match a file's
  // extension/type. A notice, not a failure — sites lie about accept.
  | "accept_mismatch"
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
  | { ok: true; data: T; profile?: ProfileStamp; notice?: string; notices?: BridgeNotice[] }
  | { ok: false; error: string; errorDetails?: BridgeError; profile?: ProfileStamp; notice?: string; notices?: BridgeNotice[] };

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
    /** Stable per-profile identity minted in chrome.storage.local (v2).
     *  Absent from pre-v2 extensions — the host then skips writing an
     *  instance descriptor and only the legacy fixed port works. */
    instanceId?: string;
    /** Chrome's "Allow access to file URLs" toggle for this extension.
     *  Gates debugger file operations (upload). Absent = unknown. */
    fileSchemeAccess?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Multi-profile (v2).
//
// Identity is MINTED, not discovered: an extension cannot read its own
// profile's name, so each install mints a UUID instanceId. Aliases (labels)
// live in a CLI-owned persistent registry — the only place uniqueness is
// enforceable. Discovery happens via per-host instance descriptor files;
// the /ping handshake (echoing instanceId) is the authority, the descriptor
// is only the pointer. See docs/multi-profile-and-upload.md.

/** Who served this call. Stamped on every post-routing result — success and
 *  failure alike — so a transcript is never ambiguous about which profile a
 *  command landed in. Routing failures (no resolved profile) instead carry
 *  details.candidates on the error. `label` is decorated CLI-side from the
 *  alias registry; the host only knows the instanceId. */
export interface ProfileStamp {
  instanceId: string;
  label?: string | null;
}

/** On-disk descriptor written by each native host to
 *  <app dir>/instances/<instanceId>.json after bridge.ready. Written
 *  atomically (temp + rename); deleted on exit only when generationId
 *  still matches the exiting process. */
export interface InstanceDescriptor {
  schemaVersion: 1;
  instanceId: string;
  /** Fresh per host process. Guards descriptor cleanup and lets /ping
   *  prove the descriptor describes the process actually on the port. */
  generationId: string;
  port: number;
  /** Bearer token required on /call for this host. Possession proves
   *  local file access (descriptor is 0600). */
  token: string;
  pid: number;
  extensionId: string;
  extensionVersion: string;
  hostVersion: string;
  protocolVersion: number;
  startedAt: string;
  /** Which browser spawned this host ("Google Chrome", "Dia", …), detected
   *  from the host's parent process. One CLI can front several Chromium
   *  browsers at once; each browser+profile is its own instance, and this
   *  is how `profile list` tells them apart. Absent when detection failed. */
  browser?: string;
}

/** /ping response (v2 fields optional — a pre-v2 host omits them). */
export interface PingResponse {
  ok: boolean;
  port: number;
  cliVersion: string;
  extensionVersion: string | null;
  extensionId: string | null;
  instanceId?: string | null;
  generationId?: string | null;
  protocolVersion?: number;
  fileSchemeAccess?: boolean | null;
}

// Host → extension, sent once at startup. This is what lets the extension
// know it may use v2 wire features (qualified refs): an OLD host never sends
// it, so a store-updated extension in front of an old CLI keeps minting bare
// refs the old CLI can parse. Deploy-skew safety, not ceremony.
export interface BridgeHelloMessage {
  type: "bridge.hello";
  payload: {
    hostVersion: string;
    protocolVersion: number;
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
  | BridgeHelloMessage
  | BridgePingMessage
  | BridgePongMessage
  | ToolCallMessage
  | ToolResultMessage;
