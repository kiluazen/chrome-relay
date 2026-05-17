import Fastify from "fastify";
import {
  DEFAULT_HTTP_PORT,
  RelayError,
  toBridgeError,
  type BridgeError,
  type BridgeNotice,
  type LocalBridgeCallRequest,
  type ToolName
} from "@chrome-relay/protocol";
import type { ExtensionBridge } from "../native/bridge.js";
import { CHROME_RELAY_VERSION } from "../index.js";
import { compareSemver } from "../release-notes.js";

// Build the cli-outdated notice once per call. Returns undefined when the CLI
// is at-or-newer than the extension (the normal case). Returns the structured
// BridgeNotice form; the response serializer wraps it for both legacy
// (string) and new (array) clients.
function buildOutdatedNotice(bridge: ExtensionBridge): BridgeNotice | undefined {
  const extVersion = bridge.getExtensionVersion();
  if (!extVersion) return undefined;
  if (compareSemver(CHROME_RELAY_VERSION, extVersion) >= 0) return undefined;
  return {
    code: "cli_outdated",
    message: `cli-outdated: ${CHROME_RELAY_VERSION} < extension ${extVersion}; run \`chrome-relay update\``,
    details: {
      currentVersion: CHROME_RELAY_VERSION,
      expectedVersion: extVersion
    },
    action: { command: "chrome-relay update" }
  };
}

// Serializer that emits BOTH the legacy string `notice` and the new
// structured `notices` array. Old clients (CLI <0.5.3) keep parsing the
// string field; new clients prefer `notices`.
function attachNotices(payload: Record<string, unknown>, notice: BridgeNotice | undefined): void {
  if (!notice) return;
  payload.notice = notice.message;
  payload.notices = [notice];
}

export class RelayHttpServer {
  private readonly app = Fastify({ logger: false });

  constructor(
    private readonly bridge: ExtensionBridge,
    private readonly port = DEFAULT_HTTP_PORT
  ) {}

  async start(): Promise<void> {
    this.app.get("/ping", async () => ({
      ok: true,
      port: this.port,
      cliVersion: CHROME_RELAY_VERSION,
      extensionVersion: this.bridge.getExtensionVersion() ?? null
    }));

    this.app.post("/call", async (request, reply) => {
      if (request.headers.origin) {
        reply.code(403).send({ error: "Browser-origin bridge requests are not accepted." });
        return;
      }

      const body = (request.body ?? {}) as Partial<LocalBridgeCallRequest>;
      if (typeof body.name !== "string") {
        reply.code(400).send({ ok: false, error: "Missing tool name." });
        return;
      }

      try {
        const data = await this.bridge.callTool(
          body.name as ToolName,
          (body.args ?? {}) as Record<string, unknown>
        );
        const notice = buildOutdatedNotice(this.bridge);
        const payload: Record<string, unknown> = { ok: true, data };
        attachNotices(payload, notice);
        reply.send(payload);
      } catch (error) {
        const notice = buildOutdatedNotice(this.bridge);
        // Preserve structured BridgeError when the handler threw a
        // RelayError; otherwise wrap as code:"internal_error" with the raw
        // message so the agent still sees a parseable shape.
        const errorDetails: BridgeError = error instanceof RelayError
          ? error.toBridgeError()
          : toBridgeError(error, body.name as ToolName);
        const payload: Record<string, unknown> = {
          ok: false,
          error: errorDetails.message,
          errorDetails
        };
        attachNotices(payload, notice);
        reply.code(500).send(payload);
      }
    });

    await this.app.listen({ port: this.port, host: "127.0.0.1" });
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}
