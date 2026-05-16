import Fastify from "fastify";
import { DEFAULT_HTTP_PORT, type LocalBridgeCallRequest, type ToolName } from "@chrome-relay/protocol";
import type { ExtensionBridge } from "../native/bridge.js";

export class RelayHttpServer {
  private readonly app = Fastify({ logger: false });

  constructor(
    private readonly bridge: ExtensionBridge,
    private readonly port = DEFAULT_HTTP_PORT
  ) {}

  async start(): Promise<void> {
    this.app.get("/ping", async () => ({ ok: true, port: this.port }));

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
        reply.send({ ok: true, data });
      } catch (error) {
        reply.code(500).send({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    await this.app.listen({ port: this.port, host: "127.0.0.1" });
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}
