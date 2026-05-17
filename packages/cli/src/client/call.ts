import {
  DEFAULT_HTTP_PORT,
  RelayError,
  type BridgeError,
  type BridgeNotice,
  type LocalBridgeCallRequest,
  type ToolName
} from "@chrome-relay/protocol";

// Once per process, suppress duplicate stderr notices so a chatty subcommand
// (e.g. a screenshot loop) doesn't spam the user with the same line.
let noticePrinted = false;

function emitNoticeOnce(notice: string): void {
  if (noticePrinted) return;
  noticePrinted = true;
  process.stderr.write(`[chrome-relay] ${notice}\n`);
}

// Wire payload from /call. Both legacy (`error` string, `notice` string) and
// new (`errorDetails`, `notices`) fields may be present — the server sends
// both for backwards compat. New code prefers the structured fields.
interface CallResponsePayload {
  ok?: boolean;
  data?: unknown;
  error?: string;
  errorDetails?: BridgeError;
  notice?: string;
  notices?: BridgeNotice[];
}

// Internal: returns both the tool data and any notices. Callers that want
// to forward the notice into their own JSON output (e.g. agent-facing
// commands) use this directly. The default `callTool` peels off `data` and
// prints the notice to stderr.
export async function callToolWithMeta(
  name: string,
  args: Record<string, unknown>
): Promise<{ data: unknown; notice?: string; notices?: BridgeNotice[] }> {
  const response = await fetch(`http://127.0.0.1:${DEFAULT_HTTP_PORT}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: name as ToolName,
      args
    } satisfies LocalBridgeCallRequest)
  });

  const payload = (await response.json().catch(() => null)) as CallResponsePayload | null;

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
  return { data: payload.data, notice: payload.notice, notices: payload.notices };
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
  args: Record<string, unknown>
): Promise<unknown> {
  const { data } = await callToolWithMeta(name, args);
  return data;
}
