import { DEFAULT_HTTP_PORT, type LocalBridgeCallRequest, type ToolName } from "@chrome-relay/protocol";

// Once per process, suppress duplicate stderr notices so a chatty subcommand
// (e.g. a screenshot loop) doesn't spam the user with the same line.
let noticePrinted = false;

function emitNoticeOnce(notice: string): void {
  if (noticePrinted) return;
  noticePrinted = true;
  process.stderr.write(`[chrome-relay] ${notice}\n`);
}

// Internal: returns both the tool data and a possible notice. Callers that
// want to forward the notice into their own JSON output (e.g. agent-facing
// commands) use this directly. The default `callTool` peels off `data` and
// prints the notice to stderr.
export async function callToolWithMeta(
  name: string,
  args: Record<string, unknown>
): Promise<{ data: unknown; notice?: string }> {
  const response = await fetch(`http://127.0.0.1:${DEFAULT_HTTP_PORT}/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: name as ToolName,
      args
    } satisfies LocalBridgeCallRequest)
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: unknown; error?: string; notice?: string }
    | null;

  if (!response.ok) {
    if (payload?.notice) emitNoticeOnce(payload.notice);
    throw new Error(payload?.error || `Bridge request failed with ${response.status}`);
  }

  if (!payload?.ok) {
    if (payload?.notice) emitNoticeOnce(payload.notice);
    throw new Error(payload?.error || "Bridge call failed.");
  }

  if (payload.notice) emitNoticeOnce(payload.notice);
  return { data: payload.data, notice: payload.notice };
}

export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const { data } = await callToolWithMeta(name, args);
  return data;
}
