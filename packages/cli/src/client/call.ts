import {
  RelayError,
  type BridgeError,
  type BridgeNotice,
  type LocalBridgeCallRequest,
  type ProfileStamp,
  type ToolName
} from "@chrome-relay/protocol";
import { compareSemver } from "../release-notes.js";
import { httpRequest } from "./http.js";
import { resolveRoute } from "./route.js";

// Once per process, suppress duplicate stderr notices so a chatty subcommand
// (e.g. a screenshot loop) doesn't spam the user with the same line.
let noticePrinted = false;

function emitNoticeOnce(notice: string): void {
  if (noticePrinted) return;
  noticePrinted = true;
  process.stderr.write(`[chrome-relay] ${notice}\n`);
}

// The profile stamp reaches the transcript on stderr — stdout keeps its
// existing contract (bare tool data). One line per process: which profile
// served this call, always, so a transcript is never ambiguous about where
// a command landed. Suppressed only on the legacy fallback route, where no
// v2 identity exists to report.
let profilePrinted = false;

function emitProfileOnce(stamp: ProfileStamp): void {
  if (profilePrinted) return;
  profilePrinted = true;
  const label = stamp.label ?? "(unlabeled)";
  process.stderr.write(`[chrome-relay] profile: ${label} [${stamp.instanceId.slice(0, 8)}]\n`);
}

// Wire payload from /call. Both legacy (`error` string, `notice` string) and
// new (`errorDetails`, `notices`) fields may be present — the server sends
// both for backwards compat. New code prefers the structured fields.
interface CallResponsePayload {
  ok?: boolean;
  data?: unknown;
  error?: string;
  errorDetails?: BridgeError;
  profile?: ProfileStamp;
  notice?: string;
  notices?: BridgeNotice[];
}

export interface CallOptions {
  /** --profile value: label or instanceId prefix. Routing also reads
   *  qualified ref prefixes out of `args` on its own. */
  profile?: string;
  /** New semantics must fail before input when the extension is older. */
  minimumExtensionVersion?: string;
}

// Program-level --profile fallback. Commands that take target flags thread
// --profile through baseArgs → __profile, but bare commands (`tabs`,
// `workspace list`, …) never touch baseArgs — this source covers them.
// buildProgram() installs it; precedence stays: explicit option > __profile
// in args > program-level flag.
let defaultProfileSource: (() => string | undefined) | undefined;

export function setDefaultProfileSource(source: () => string | undefined): void {
  defaultProfileSource = source;
}

/** Test-only: the notice/stamp lines print once per process, which bleeds
 *  across tests sharing this module instance. */
export function __resetOncePerProcessFlagsForTests(): void {
  noticePrinted = false;
  profilePrinted = false;
}

// What still works against an older extension, so the compatibility error
// says how to keep going instead of only how to upgrade. The first command
// of the core loop (`navigate`) hits this gate, so the hint matters.
function fallbackFor(tool: string, input: Record<string, unknown>): string | undefined {
  if (input.settle === true) {
    return tool === "chrome_snapshot"
      ? "drop --settle, and wait for the element or text you expect first."
      : "drop --snapshot, then run `snapshot -i` after the action.";
  }
  if (tool === "chrome_navigate") {
    return "rerun with --wait none (returns at once), then `wait --text`/`wait <selector>` for what you need before snapshotting.";
  }
  if (tool === "chrome_screencast") return "use `screenshot` for stills.";
  if (tool === "chrome_batch") return "remove waitUntil/settle from the batched commands.";
  return undefined;
}

// Internal: returns both the tool data and any notices. Callers that want
// to forward the notice into their own JSON output (e.g. agent-facing
// commands) use this directly. The default `callTool` peels off `data` and
// prints the notice to stderr.
export async function callToolWithMeta(
  name: string,
  args: Record<string, unknown>,
  options: CallOptions = {}
): Promise<{ data: unknown; profile?: ProfileStamp; notice?: string; notices?: BridgeNotice[] }> {
  // `__profile` is a CLI-internal routing hint smuggled through the args
  // object (so every callTool caller gets routing without a signature
  // change). It is stripped HERE — it never goes on the wire; the extension
  // has no concept of profiles, it IS one.
  let profile = options.profile;
  if (typeof args.__profile === "string") {
    profile = profile ?? args.__profile;
    args = { ...args };
    delete args.__profile;
  }
  profile = profile ?? defaultProfileSource?.();

  const route = await resolveRoute(profile, args);
  const newSemantics = (tool: string, input: Record<string, unknown>) =>
    input.settle === true || (tool === "chrome_navigate" && input.waitUntil && input.waitUntil !== "none") ||
    (tool === "chrome_screencast" && input.action === "start") || tool === "chrome_cursor";
  const requiresNewExtension = newSemantics(name, args) || (name === "chrome_batch" &&
    Array.isArray(args.commands) && args.commands.some(command => newSemantics(command.name, command.args ?? {})));
  const minimumVersion = options.minimumExtensionVersion ?? (requiresNewExtension ? "0.9.0" : undefined);
  if (minimumVersion) {
    let version = route.extensionVersion;
    if (!version) {
      // Only legacy routes need another probe; v2 routing already verifies
      // the profile and carries its connected extension version.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      try {
        const ping = await httpRequest(`${route.baseUrl}/ping`, { signal: controller.signal });
        if (ping.ok) version = (await ping.json() as { extensionVersion?: string }).extensionVersion;
      } catch { /* fail closed below when the version cannot be proved */ }
      finally { clearTimeout(timer); }
    }
    if (!version || compareSemver(version, minimumVersion) < 0) {
      throw new RelayError({
        code: "unsupported_tool",
        message:
          `This operation requires Chrome Relay extension ${minimumVersion}; connected version is ${version ?? "unknown"}. ` +
          `The CLI update does not update Chrome extensions: Chrome pulls the Web Store update on its own within a few hours ` +
          `(to get it now: chrome://extensions → Developer mode → Update, or restart the browser).` +
          (fallbackFor(name, args) ? ` Until then: ${fallbackFor(name, args)}` : ""),
        tool: name as ToolName, phase: "extension_compatibility",
        details: {
          extensionVersion: version ?? null,
          requiredExtensionVersion: minimumVersion,
          ...(fallbackFor(name, args) ? { fallback: fallbackFor(name, args) } : {})
        },
        retryable: false
      });
    }
  }

  const response = await httpRequest(`${route.baseUrl}/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(route.token ? { authorization: `Bearer ${route.token}` } : {})
    },
    body: JSON.stringify({
      name: name as ToolName,
      args
    } satisfies LocalBridgeCallRequest)
  });

  const payload = (await response.json().catch(() => null)) as CallResponsePayload | null;

  // Prefer the server's stamp (the authority — it names the process that
  // actually served the call); fall back to the routing decision, decorated
  // with the label the routing layer already resolved.
  const stamp: ProfileStamp | undefined = payload?.profile
    ? { ...payload.profile, label: route.label ?? payload.profile.label ?? null }
    : route.instanceId
      ? { instanceId: route.instanceId, label: route.label ?? null }
      : undefined;
  if (stamp) emitProfileOnce(stamp);

  const noticeString = payload?.notice ?? payload?.notices?.[0]?.message;

  if (!response.ok) {
    if (noticeString) emitNoticeOnce(noticeString);
    throw rebuildError(payload, `Bridge request failed with ${response.status}`);
  }

  if (!payload?.ok) {
    if (noticeString) emitNoticeOnce(noticeString);
    throw rebuildError(payload, "Bridge call failed.");
  }

  if (noticeString) emitNoticeOnce(noticeString);
  return { data: payload.data, profile: stamp, notice: payload.notice, notices: payload.notices };
}

// Rebuild a structured RelayError when the server sent errorDetails;
// otherwise return a plain Error preserving the legacy `error` string.
function rebuildError(payload: CallResponsePayload | null, fallbackMessage: string): Error {
  if (payload?.errorDetails) {
    return new RelayError(payload.errorDetails);
  }
  return new Error(payload?.error || fallbackMessage);
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  options: CallOptions = {}
): Promise<unknown> {
  const { data } = await callToolWithMeta(name, args, options);
  return data;
}
