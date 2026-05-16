#!/usr/bin/env node

import process from "node:process";
import type { BridgeMessage } from "@chrome-relay/protocol";
import { RelayHttpServer } from "./http/server.js";
import { ExtensionBridge } from "./native/bridge.js";
import { readNativeMessages, writeNativeMessage } from "./native/framing.js";

const bridge = new ExtensionBridge((message) => {
  writeNativeMessage(process.stdout, message);
});

const server = new RelayHttpServer(bridge);

async function main(): Promise<void> {
  await server.start();
  readNativeMessages(process.stdin, (message) => {
    bridge.handleMessage(message as BridgeMessage);
  });

  process.stdin.resume();
  process.stdin.on("end", async () => {
    await server.stop();
    process.exit(0);
  });
}

main().catch(async (error) => {
  console.error(error);
  await server.stop();
  process.exit(1);
});
