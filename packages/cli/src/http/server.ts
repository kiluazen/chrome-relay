import Fastify from "fastify";
import {
  DEFAULT_HTTP_PORT,
  PROTOCOL_VERSION,
  RelayError,
  toBridgeError,
  type BridgeError,
  type BridgeNotice,
  type LocalBridgeCallRequest,
  type PingResponse,
  type ProfileStamp,
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

export interface RelayHttpServerOptions {
  /** 0 = ephemeral (the v2 registry path); DEFAULT_HTTP_PORT for the legacy
   *  fixed-port listener. */
  port?: number;
  /** When set, /call requires `authorization: Bearer <token>`. The v2
   *  ephemeral listener always sets it; the legacy 12122 listener doesn't
   *  (pre-v2 clients know neither registry nor token). /ping stays open —
   *  it IS the discovery handshake. */
  token?: string;
  /** Echoed on /ping so a client can prove the process on this port is the
   *  one its descriptor describes. */
  generationId?: string;
}

export class RelayHttpServer {
  private readonly app = Fastify({ logger: false });
  private readonly port: number;
  private readonly token: string | undefined;
  private readonly generationId: string | undefined;
  private boundPort: number | null = null;

  constructor(
    private readonly bridge: ExtensionBridge,
    options: RelayHttpServerOptions | number = {}
  ) {
    // Back-compat: the old constructor took a bare port number.
    const opts = typeof options === "number" ? { port: options } : options;
    this.port = opts.port ?? DEFAULT_HTTP_PORT;
    this.token = opts.token;
    this.generationId = opts.generationId;
  }

  /** The actual bound port — differs from the requested one when 0
   *  (ephemeral) was requested. Null before start(). */
  getBoundPort(): number | null {
    return this.boundPort;
  }

  /** Post-routing profile stamp: this host IS the routed endpoint, so every
   *  response it serves identifies the profile that served it. Absent only
   *  when a pre-v2 extension never sent an instanceId. The label half is
   *  decorated client-side from the alias registry. */
  private profileStamp(): ProfileStamp | undefined {
    const instanceId = this.bridge.getInstanceId();
    return instanceId ? { instanceId } : undefined;
  }

  async start(): Promise<void> {
    this.app.get("/ping", async () => {
      const payload: PingResponse = {
        ok: true,
        port: this.boundPort ?? this.port,
        cliVersion: CHROME_RELAY_VERSION,
        extensionVersion: this.bridge.getExtensionVersion() ?? null,
        extensionId: this.bridge.getExtensionId() ?? null,
        instanceId: this.bridge.getInstanceId() ?? null,
        generationId: this.generationId ?? null,
        protocolVersion: PROTOCOL_VERSION,
        fileSchemeAccess: this.bridge.getFileSchemeAccess() ?? null
      };
      return payload;
    });

    this.app.post("/call", async (request, reply) => {
      if (request.headers.origin) {
        reply.code(403).send({ error: "Browser-origin bridge requests are not accepted." });
        return;
      }

      if (this.token !== undefined && request.headers.authorization !== `Bearer ${this.token}`) {
        const errorDetails: BridgeError = {
          code: "unauthorized",
          message:
            "Missing or wrong bearer token for this host. The descriptor you routed by is stale — re-discover via the instance registry.",
          retryable: false
        };
        reply.code(401).send({ ok: false, error: errorDetails.message, errorDetails });
        return;
      }

      const body = (request.body ?? {}) as Partial<LocalBridgeCallRequest>;
      if (typeof body.name !== "string") {
        reply.code(400).send({ ok: false, error: "Missing tool name." });
        return;
      }

      const profile = this.profileStamp();
      try {
        const data = await this.bridge.callTool(
          body.name as ToolName,
          (body.args ?? {}) as Record<string, unknown>
        );
        const notice = buildOutdatedNotice(this.bridge);
        const payload: Record<string, unknown> = { ok: true, data };
        if (profile) payload.profile = profile;
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
        if (profile) payload.profile = profile;
        attachNotices(payload, notice);
        reply.code(500).send(payload);
      }
    });

    await this.app.listen({ port: this.port, host: "127.0.0.1" });
    const address = this.app.server.address();
    this.boundPort = typeof address === "object" && address ? address.port : this.port;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}
