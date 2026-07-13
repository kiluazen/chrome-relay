#!/usr/bin/env node

// Native messaging host — one process per connected extension instance
// (i.e. per Chrome profile running the extension).
//
// v2 lifecycle: bind an EPHEMERAL port (no more single-port last-wins race
// between profiles), then — once bridge.ready delivers the profile's
// instanceId — write an instance descriptor so clients can discover this
// host. A second, token-less listener still tries the legacy fixed port
// 12122 opportunistically so pre-v2 CLIs keep working; losing that bind race
// (another profile's host, or an older host, got there first) is NON-FATAL.
//
// Cleanup is generation-guarded: this process deletes its descriptor only
// while the on-disk generationId is still its own, so a late-exiting old
// host can never delete the descriptor of the newer host that replaced it.

import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_HTTP_PORT,
  PROTOCOL_VERSION,
  type BridgeMessage,
  type InstanceDescriptor
} from "@chrome-relay/protocol";
import { RelayHttpServer } from "./http/server.js";
import { ExtensionBridge } from "./native/bridge.js";
import { readNativeMessages, writeNativeMessage } from "./native/framing.js";
import { removeInstanceDescriptor, writeInstanceDescriptor } from "./registry.js";
import { CHROME_RELAY_VERSION } from "./index.js";

const generationId = randomUUID();
const token = randomUUID();

const bridge = new ExtensionBridge((message) => {
  writeNativeMessage(process.stdout, message);
});

const server = new RelayHttpServer(bridge, { port: 0, token, generationId });
// Legacy fixed-port listener: token-less, because pre-v2 clients know
// neither the registry nor the token. First host to launch wins the port;
// losing is fine — v2 clients discover via the registry either way.
const legacyServer = new RelayHttpServer(bridge, { port: DEFAULT_HTTP_PORT, generationId });
let legacyBound = false;

let descriptorInstanceId: string | null = null;

function cleanupDescriptor(): void {
  if (descriptorInstanceId) {
    removeInstanceDescriptor(descriptorInstanceId, generationId);
    descriptorInstanceId = null;
  }
}

async function shutdown(code: number): Promise<never> {
  cleanupDescriptor();
  try {
    await server.stop();
  } catch { /* already down */ }
  if (legacyBound) {
    try {
      await legacyServer.stop();
    } catch { /* already down */ }
  }
  process.exit(code);
}

async function writeDescriptorWhenReady(): Promise<void> {
  // Ready normally arrives right after connect (the extension posts it on
  // connectNative). A generous timeout tolerates slow SW cold starts; if it
  // never arrives, the host still serves the legacy port fine.
  try {
    await bridge.waitUntilReady(60_000);
  } catch {
    process.stderr.write("[chrome-relay host] bridge.ready never arrived — no descriptor written.\n");
    return;
  }
  const instanceId = bridge.getInstanceId();
  const port = server.getBoundPort();
  if (!instanceId) {
    // Pre-v2 extension: no identity, no descriptor. Legacy port only.
    process.stderr.write(
      "[chrome-relay host] extension sent no instanceId (pre-v2) — registry discovery unavailable for this profile.\n"
    );
    return;
  }
  if (port === null) return;
  const descriptor: InstanceDescriptor = {
    schemaVersion: 1,
    instanceId,
    generationId,
    port,
    token,
    pid: process.pid,
    extensionId: bridge.getExtensionId() ?? "",
    extensionVersion: bridge.getExtensionVersion() ?? "",
    hostVersion: CHROME_RELAY_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: new Date().toISOString()
  };
  writeInstanceDescriptor(descriptor);
  descriptorInstanceId = instanceId;
}

async function main(): Promise<void> {
  await server.start();
  try {
    await legacyServer.start();
    legacyBound = true;
  } catch {
    // Port 12122 taken (another profile's host, or an older host). Fine:
    // v2 clients route via the registry; the port's owner serves old ones.
  }

  readNativeMessages(process.stdin, (message) => {
    bridge.handleMessage(message as BridgeMessage);
  });

  process.stdin.resume();
  process.stdin.on("end", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
  process.on("SIGINT", () => {
    void shutdown(0);
  });
  // Last-resort cleanup — synchronous, safe in an exit handler.
  process.on("exit", () => {
    cleanupDescriptor();
  });

  void writeDescriptorWhenReady();
}

main().catch(async (error) => {
  console.error(error);
  await shutdown(1);
});
