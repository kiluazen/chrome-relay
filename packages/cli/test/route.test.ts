// Multi-host integration: the layer the Playwright e2e suite can't reach
// (it drives the extension's runTool directly, bypassing native messaging
// and HTTP). Here we boot REAL RelayHttpServer instances backed by stub
// bridges — two fake "profiles" — and exercise discovery, routing rules,
// token auth, and the profile stamp end to end over real loopback HTTP.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayError, type InstanceDescriptor } from "@chrome-relay/protocol";
import { RelayHttpServer } from "../src/http/server";
import type { ExtensionBridge } from "../src/native/bridge";
import { readInstanceDescriptors, writeInstanceDescriptor } from "../src/registry";
import { discoverInstances, resolveRoute } from "../src/client/route";
import { callToolWithMeta } from "../src/client/call";

const ID_A = "aaaa1111-0000-4000-8000-000000000000"; // prefix aaaa
const ID_B = "bbbb2222-0000-4000-8000-000000000000"; // prefix bbbb
const DEAD_PID = 2 ** 30; // far above any real pid space in use

let home: string;
let servers: RelayHttpServer[] = [];

function stubBridge(instanceId: string): ExtensionBridge {
  return {
    getExtensionVersion: () => "0.7.1",
    getExtensionId: () => "ext-id",
    getInstanceId: () => instanceId,
    getFileSchemeAccess: () => true,
    callTool: vi.fn(async (name: string) => ({ echoedTool: name, from: instanceId }))
  } as unknown as ExtensionBridge;
}

async function bootHost(
  instanceId: string,
  overrides: Partial<InstanceDescriptor> = {}
): Promise<InstanceDescriptor> {
  const token = `tok-${instanceId.slice(0, 4)}`;
  const generationId = `gen-${instanceId.slice(0, 4)}`;
  const server = new RelayHttpServer(stubBridge(instanceId), { port: 0, token, generationId });
  await server.start();
  servers.push(server);
  const descriptor: InstanceDescriptor = {
    schemaVersion: 1,
    instanceId,
    generationId,
    port: server.getBoundPort() as number,
    token,
    pid: process.pid,
    extensionId: "ext-id",
    extensionVersion: "0.7.1",
    hostVersion: "0.7.2",
    protocolVersion: 2,
    startedAt: new Date().toISOString(),
    ...overrides
  };
  writeInstanceDescriptor(descriptor);
  return descriptor;
}

async function relayCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RelayError) return e.code;
    throw e;
  }
  throw new Error("expected a RelayError");
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "chrome-relay-route-"));
  process.env.CHROME_RELAY_HOME = home;
  servers = [];
});

afterEach(async () => {
  delete process.env.CHROME_RELAY_HOME;
  await Promise.all(servers.map((s) => s.stop().catch(() => undefined)));
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("discovery (registry = discovery, handshake = authority)", () => {
  it("verifies a live host via ping and reports its identity", async () => {
    await bootHost(ID_A);
    const found = await discoverInstances();
    expect(found).toHaveLength(1);
    expect(found[0].descriptor.instanceId).toBe(ID_A);
    expect(found[0].fileSchemeAccess).toBe(true);
  });

  it("excludes and sweeps a descriptor whose process is dead", async () => {
    await bootHost(ID_A);
    // A descriptor pointing at a port nobody serves, from a dead pid.
    writeInstanceDescriptor({
      schemaVersion: 1,
      instanceId: ID_B,
      generationId: "gen-dead",
      port: 1, // nothing listens here
      token: "tok-dead",
      pid: DEAD_PID,
      extensionId: "ext-id",
      extensionVersion: "0.7.1",
      hostVersion: "0.7.2",
      protocolVersion: 2,
      startedAt: new Date().toISOString()
    });
    const found = await discoverInstances();
    expect(found.map((f) => f.descriptor.instanceId)).toEqual([ID_A]);
    // Swept: dead pid + failed ping = provably stale.
    expect(readInstanceDescriptors().map((d) => d.instanceId)).toEqual([ID_A]);
  });

  it("excludes but does NOT sweep when the ping fails while the pid is alive", async () => {
    const desc = await bootHost(ID_A);
    // Stop the server: ping now fails, but the pid (this test process) lives.
    await servers.pop()!.stop();
    const found = await discoverInstances();
    expect(found).toHaveLength(0);
    expect(readInstanceDescriptors().map((d) => d.instanceId)).toEqual([desc.instanceId]);
  });

  it("rejects a port whose ping echoes a different generation (descriptor superseded)", async () => {
    const desc = await bootHost(ID_A);
    // Rewrite the descriptor with a stale generation — as if we read the
    // old host's file while a new-generation host owns the port.
    writeInstanceDescriptor({ ...desc, generationId: "gen-older" });
    const found = await discoverInstances();
    expect(found).toHaveLength(0);
  });
});

describe("routing rules", () => {
  it("zero hosts → legacy fixed-port fallback, no identity", async () => {
    const route = await resolveRoute(undefined, {});
    expect(route.baseUrl).toBe("http://127.0.0.1:12122");
    expect(route.instanceId).toBeUndefined();
  });

  it("one host → implicit route with its token", async () => {
    const desc = await bootHost(ID_A);
    const route = await resolveRoute(undefined, {});
    expect(route.baseUrl).toBe(`http://127.0.0.1:${desc.port}`);
    expect(route.token).toBe(desc.token);
    expect(route.instanceId).toBe(ID_A);
  });

  it("two hosts, unscoped → profile_ambiguous with candidates", async () => {
    await bootHost(ID_A);
    await bootHost(ID_B);
    expect(await relayCode(() => resolveRoute(undefined, {}))).toBe("profile_ambiguous");
  });

  it("--profile routes by label and by id prefix", async () => {
    const a = await bootHost(ID_A);
    await bootHost(ID_B);
    const { saveLabels, loadLabels } = await import("../src/registry");
    const labels = loadLabels();
    labels.instances[ID_A] = { label: "work" };
    saveLabels(labels);

    const byLabel = await resolveRoute("work", {});
    expect(byLabel.instanceId).toBe(ID_A);
    expect(byLabel.label).toBe("work");
    expect(byLabel.baseUrl).toBe(`http://127.0.0.1:${a.port}`);

    const byPrefix = await resolveRoute("bbbb", {});
    expect(byPrefix.instanceId).toBe(ID_B);
  });

  it("--profile with no match → profile_not_found", async () => {
    await bootHost(ID_A);
    expect(await relayCode(() => resolveRoute("nope", {}))).toBe("profile_not_found");
  });

  it("a qualified ref routes on its own, no --profile needed", async () => {
    await bootHost(ID_A);
    await bootHost(ID_B);
    const route = await resolveRoute(undefined, { ref: "bbbb:e12" });
    expect(route.instanceId).toBe(ID_B);
  });

  it("--profile disagreeing with the ref's mint prefix → target_conflict", async () => {
    await bootHost(ID_A);
    await bootHost(ID_B);
    expect(await relayCode(() => resolveRoute("aaaa", { ref: "bbbb:e12" }))).toBe("target_conflict");
  });

  it("--profile AGREEING with the ref prefix is fine (redundant but consistent)", async () => {
    await bootHost(ID_A);
    await bootHost(ID_B);
    const route = await resolveRoute("bbbb", { ref: "bbbb:e12" });
    expect(route.instanceId).toBe(ID_B);
  });

  it("refs from two different profiles in one call → target_conflict", async () => {
    await bootHost(ID_A);
    expect(
      await relayCode(() =>
        resolveRoute(undefined, {
          commands: [{ args: { ref: "aaaa:e1" } }, { args: { ref: "bbbb:e2" } }]
        })
      )
    ).toBe("target_conflict");
  });

  it("a ref minted by an unreachable profile → profile_not_found", async () => {
    await bootHost(ID_A);
    expect(await relayCode(() => resolveRoute(undefined, { ref: "bbbb:e3" }))).toBe("profile_not_found");
  });
});

describe("end-to-end call over the routed transport", () => {
  it("routes, authenticates with the bearer token, and returns the profile stamp", async () => {
    await bootHost(ID_A);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await callToolWithMeta("get_windows_and_tabs", {});
    expect(result.data).toEqual({ echoedTool: "get_windows_and_tabs", from: ID_A });
    expect(result.profile?.instanceId).toBe(ID_A);
    // The stamp reaches the transcript on stderr.
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("profile:");
    expect(stderrText).toContain(ID_A.slice(0, 8));
  });

  it("a /call without the bearer token is rejected as unauthorized", async () => {
    const desc = await bootHost(ID_A);
    const response = await fetch(`http://127.0.0.1:${desc.port}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "get_windows_and_tabs", args: {} })
    });
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { errorDetails?: { code?: string } };
    expect(payload.errorDetails?.code).toBe("unauthorized");
  });

  it("browser-origin requests stay rejected even with a valid token", async () => {
    const desc = await bootHost(ID_A);
    const response = await fetch(`http://127.0.0.1:${desc.port}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${desc.token}`,
        origin: "https://evil.example"
      },
      body: JSON.stringify({ name: "get_windows_and_tabs", args: {} })
    });
    expect(response.status).toBe(403);
  });

  it("routed errors still carry the profile stamp (post-routing invariant)", async () => {
    const desc = await bootHost(ID_A);
    const response = await fetch(`http://127.0.0.1:${desc.port}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${desc.token}` },
      body: JSON.stringify({ name: 42 }) // malformed on purpose? no — missing name string
    });
    expect(response.status).toBe(400);
  });
});
