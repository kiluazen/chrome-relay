import { randomUUID } from "node:crypto";
import type {
  BridgeMessage,
  BridgePingMessage,
  BridgeReadyMessage,
  ToolArguments,
  ToolName,
  ToolResultMessage
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

  constructor(private readonly send: (message: BridgeMessage) => void) {}

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

  private handleReady(_message: BridgeReadyMessage): void {
    this.ready = true;
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

    pending.reject(new Error(message.payload.error));
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
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

  async ping(timeoutMs = 2_000): Promise<boolean> {
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

  async callTool(name: ToolName, args: ToolArguments, timeoutMs = 30_000): Promise<unknown> {
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
