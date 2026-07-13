import {
  RelayError,
  type BridgeError,
  type BridgeNotice,
  type LocalBridgeCallRequest,
  type ProfileStamp,
  type ToolName
} from "@chrome-relay/protocol";
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

  const route = await resolveRoute(profile, args);

  const response = await fetch(`${route.baseUrl}/call`, {
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
