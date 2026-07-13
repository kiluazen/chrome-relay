import { randomUUID } from "node:crypto";
import type {
  BridgeError,
  BridgeMessage,
  BridgePingMessage,
  BridgeReadyMessage,
  ToolArguments,
  ToolName,
  ToolResultMessage
} from "@chrome-relay/protocol";
import {
  DEFAULT_PING_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  RelayError
} from "@chrome-relay/protocol";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ExtensionBridge {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyWaiters = new Set<() => void>();
  private ready = false;
  // Extension version + id captured from `bridge.ready`. Version feeds the
  // cli-outdated notice; the id tells doctor WHICH extension owns the bridge
  // (store vs unpacked dev — they race for the port when both are loaded).
  private extensionVersion: string | undefined;
  private extensionId: string | undefined;
  // v2 identity from `bridge.ready`: the minted per-profile instanceId
  // (keys the instance descriptor) and the file-URL-access toggle state
  // (surfaced on /ping for doctor). Absent from pre-v2 extensions.
  private instanceId: string | undefined;
  private fileSchemeAccess: boolean | undefined;

  constructor(private readonly send: (message: BridgeMessage) => void) {}

  getExtensionVersion(): string | undefined {
    return this.extensionVersion;
  }

  getExtensionId(): string | undefined {
    return this.extensionId;
  }

  getInstanceId(): string | undefined {
    return this.instanceId;
  }

  getFileSchemeAccess(): boolean | undefined {
    return this.fileSchemeAccess;
  }

  handleMessage(message: BridgeMessage): void {
    if (message.type === "bridge.ready") {
      this.handleReady(message);
      return;
    }

    if (message.type === "tool.result") {
      this.handleToolResult(message);
      return;
    }

    if (message.type === "bridge.pong") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(true);
    }
  }

  private handleReady(message: BridgeReadyMessage): void {
    this.ready = true;
    this.extensionVersion = message.payload?.version;
    this.extensionId = message.payload?.extensionId;
    this.instanceId = message.payload?.instanceId;
    this.fileSchemeAccess = message.payload?.fileSchemeAccess;
    for (const notify of this.readyWaiters) {
      notify();
    }
    this.readyWaiters.clear();
  }

  private handleToolResult(message: ToolResultMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.payload.ok) {
      pending.resolve(message.payload.data);
      return;
    }

    // Reject with a RelayError carrying the structured details when the
    // extension provided them. Falls back to a plain Error for legacy
    // (extension <0.5.3) payloads that only carry the string `error` field.
    const details = message.payload.errorDetails;
    if (details) {
      pending.reject(new RelayError(details as BridgeError));
    } else {
      pending.reject(new Error(message.payload.error));
    }
  }

  async waitUntilReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    if (this.ready) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(onReady);
        reject(new Error("Chrome Relay extension is not connected."));
      }, timeoutMs);

      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };

      this.readyWaiters.add(onReady);
    });
  }

  async ping(timeoutMs = DEFAULT_PING_TIMEOUT_MS): Promise<boolean> {
    const id = randomUUID();
    const message: BridgePingMessage = { type: "bridge.ping", id };

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: () => resolve(true),
        reject: () => resolve(false),
        timer
      });

      this.send(message);
    });
  }

  async callTool(name: ToolName, args: ToolArguments, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS): Promise<unknown> {
    await this.waitUntilReady();

    const id = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for tool result: ${name}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.send({
        type: "tool.call",
        id,
        payload: { name, args }
      });
    });
  }
}
