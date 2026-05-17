// Tool dispatcher — assembles per-domain handler maps and exposes runTool.
//
// Code-quality-hardening PR 7 (file split): handlers used to live in this
// file (891 lines). Now each domain owns its handlers under
// `apps/extension/src/browser/handlers/*.ts`; this file just merges them.
// Adding a new tool: implement the handler in the matching domain file
// (or create a new one), then add it to the spread below.

import { RelayError, type ToolArguments, type ToolName } from "@chrome-relay/protocol";
import type { ToolHandler } from "./handlers/target";
import { navigationHandlers } from "./handlers/navigation";
import { inputHandlers } from "./handlers/input";
import { captureHandlers } from "./handlers/capture";
import { sessionsHandlers } from "./handlers/sessions";

const handlers: Partial<Record<ToolName, ToolHandler>> = {
  ...(navigationHandlers as Partial<Record<ToolName, ToolHandler>>),
  ...(inputHandlers as Partial<Record<ToolName, ToolHandler>>),
  ...(captureHandlers as Partial<Record<ToolName, ToolHandler>>),
  ...(sessionsHandlers as Partial<Record<ToolName, ToolHandler>>)
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
