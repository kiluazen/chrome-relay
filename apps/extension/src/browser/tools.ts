// Tool dispatcher — assembles per-domain handler maps and exposes runTool.
//
// Code-quality-hardening PR 7 (file split): handlers used to live in this
// file (891 lines). Now each domain owns its handlers under
// `apps/extension/src/browser/handlers/*.ts`; this file just merges them.
// Adding a new tool: implement the handler in the matching domain file
// (or create a new one), then add it to the spread below.

import {
  parseChromeBatchArgs,
  RelayError,
  toBridgeError,
  TOOL_NAMES,
  type ToolArguments,
  type ToolName
} from "@chrome-relay/protocol";
import type { ToolHandler } from "./handlers/target";
import { navigationHandlers } from "./handlers/navigation";
import { inputHandlers } from "./handlers/input";
import { captureHandlers } from "./handlers/capture";
import { sessionsHandlers } from "./handlers/sessions";
import { waitHandlers } from "./handlers/wait";
import { uploadHandlers } from "./handlers/upload";

const handlers: Partial<Record<ToolName, ToolHandler>> = {
  ...(navigationHandlers as Partial<Record<ToolName, ToolHandler>>),
  ...(inputHandlers as Partial<Record<ToolName, ToolHandler>>),
  ...(captureHandlers as Partial<Record<ToolName, ToolHandler>>),
  ...(sessionsHandlers as Partial<Record<ToolName, ToolHandler>>),
  ...(waitHandlers as Partial<Record<ToolName, ToolHandler>>),
  ...(uploadHandlers as Partial<Record<ToolName, ToolHandler>>)
};

export async function runTool(name: ToolName, args: ToolArguments): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) {
    throw new RelayError({
      code: "unsupported_tool",
      message: `Unsupported tool: ${name}`,
      details: { received: name },
      retryable: false
    });
  }
  return handler(args);
}

// chrome_batch (adoption-spec Change 5) — lives here, not in a domain
// handler file, because it's a loop over the dispatch map itself: one
// native-messaging round-trip, sequential execution, bail-on-error by
// default. The parser already rejects nested batches.
handlers[TOOL_NAMES.BATCH] = async (args) => {
  const parsed = parseChromeBatchArgs(args);
  const results: Array<
    | { ok: true; name: ToolName; data: unknown }
    | { ok: false; name: ToolName; errorDetails: ReturnType<typeof toBridgeError> }
  > = [];
  for (const cmd of parsed.commands) {
    try {
      results.push({ ok: true, name: cmd.name, data: await runTool(cmd.name, cmd.args ?? {}) });
    } catch (e) {
      results.push({ ok: false, name: cmd.name, errorDetails: toBridgeError(e, cmd.name) });
      if (parsed.bail) break;
    }
  }
  return { results, completed: results.length, total: parsed.commands.length };
};
