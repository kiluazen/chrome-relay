import { DEFAULT_HTTP_PORT, type LocalBridgeCallRequest, type ToolName } from "@chrome-relay/protocol";

export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
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
    | { ok?: boolean; data?: unknown; error?: string }
    | null;

  if (!response.ok) {
    throw new Error(payload?.error || `Bridge request failed with ${response.status}`);
  }

  if (!payload?.ok) {
    throw new Error(payload?.error || "Bridge call failed.");
  }

  return payload.data;
}
