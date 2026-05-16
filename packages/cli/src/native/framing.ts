import type { BridgeMessage } from "@chrome-relay/protocol";
import type { Readable, Writable } from "node:stream";

export function writeNativeMessage(stream: Writable, message: BridgeMessage): void {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  stream.write(header);
  stream.write(payload);
}

export function readNativeMessages(
  stream: Readable,
  onMessage: (message: BridgeMessage) => void
): void {
  let buffer = Buffer.alloc(0);

  stream.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) {
        break;
      }

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onMessage(JSON.parse(payload.toString("utf8")) as BridgeMessage);
    }
  });
}
