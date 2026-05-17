import Fastify from "fastify";
import { DEFAULT_HTTP_PORT, type LocalBridgeCallRequest, type ToolName } from "@chrome-relay/protocol";
import type { ExtensionBridge } from "../native/bridge.js";
import { CHROME_RELAY_VERSION } from "../index.js";
import { compareSemver } from "../release-notes.js";

// Build the cli-outdated notice once per call. Returns undefined when the CLI
// is at-or-newer than the extension (the normal case). Stable, parseable
// string so agents can grep for the "cli-outdated:" prefix.
function buildOutdatedNotice(bridge: ExtensionBridge): string | undefined {
  const extVersion = bridge.getExtensionVersion();
  if (!extVersion) return undefined;
  if (compareSemver(CHROME_RELAY_VERSION, extVersion) >= 0) return undefined;
  return `cli-outdated: ${CHROME_RELAY_VERSION} < extension ${extVersion}; run \`chrome-relay update\``;
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
        reply.send(notice ? { ok: true, data, notice } : { ok: true, data });
      } catch (error) {
        const notice = buildOutdatedNotice(this.bridge);
        const body: Record<string, unknown> = {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
        if (notice) body.notice = notice;
        reply.code(500).send(body);
      }
    });

    await this.app.listen({ port: this.port, host: "127.0.0.1" });
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}
