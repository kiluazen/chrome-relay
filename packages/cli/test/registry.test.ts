import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstanceDescriptor } from "@chrome-relay/protocol";
import {
  appDir,
  deleteInstanceDescriptor,
  instancesDir,
  labelFor,
  loadLabels,
  readInstanceDescriptors,
  removeInstanceDescriptor,
  saveLabels,
  writeInstanceDescriptor
} from "../src/registry";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "chrome-relay-registry-"));
  process.env.CHROME_RELAY_HOME = home;
});

afterEach(() => {
  delete process.env.CHROME_RELAY_HOME;
  rmSync(home, { recursive: true, force: true });
});

function descriptor(overrides: Partial<InstanceDescriptor> = {}): InstanceDescriptor {
  return {
    schemaVersion: 1,
    instanceId: "3f2a9c1e-0000-4000-8000-000000000000",
    generationId: "gen-a",
    port: 40001,
    token: "tok-a",
    pid: process.pid,
    extensionId: "ext",
    extensionVersion: "0.8.0",
    hostVersion: "0.8.0",
    protocolVersion: 2,
    startedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

describe("registry paths", () => {
  it("honors the CHROME_RELAY_HOME override", () => {
    expect(appDir()).toBe(home);
    expect(instancesDir()).toBe(path.join(home, "instances"));
  });
});

describe("instance descriptors", () => {
  it("write → read round-trips, atomically (no tmp litter)", () => {
    writeInstanceDescriptor(descriptor());
    const all = readInstanceDescriptors();
    expect(all).toHaveLength(1);
    expect(all[0].instanceId).toBe("3f2a9c1e-0000-4000-8000-000000000000");
    expect(readdirSync(instancesDir()).filter((n) => n.includes(".tmp"))).toHaveLength(0);
  });

  it("skips garbage files instead of dying on them", () => {
    writeInstanceDescriptor(descriptor());
    writeFileSync(path.join(instancesDir(), "junk.json"), "{ not json");
    writeFileSync(path.join(instancesDir(), "wrong-shape.json"), JSON.stringify({ hello: 1 }));
    expect(readInstanceDescriptors()).toHaveLength(1);
  });

  it("returns [] when the instances dir has never been created", () => {
    expect(readInstanceDescriptors()).toEqual([]);
  });

  it("generation-guarded removal: a stale generation cannot delete a newer descriptor", () => {
    // Old host (gen-a) wrote, newer host (gen-b) overwrote — the old host's
    // late exit must NOT delete the newer host's descriptor.
    writeInstanceDescriptor(descriptor({ generationId: "gen-b", port: 40002 }));
    removeInstanceDescriptor("3f2a9c1e-0000-4000-8000-000000000000", "gen-a");
    expect(readInstanceDescriptors()).toHaveLength(1);
    // The rightful owner's cleanup works.
    removeInstanceDescriptor("3f2a9c1e-0000-4000-8000-000000000000", "gen-b");
    expect(readInstanceDescriptors()).toHaveLength(0);
  });

  it("deleteInstanceDescriptor is unconditional (the client's verified sweep)", () => {
    writeInstanceDescriptor(descriptor());
    deleteInstanceDescriptor("3f2a9c1e-0000-4000-8000-000000000000");
    expect(readInstanceDescriptors()).toHaveLength(0);
  });
});

describe("labels", () => {
  it("starts empty and round-trips", () => {
    expect(loadLabels()).toEqual({ instances: {} });
    const labels = loadLabels();
    labels.instances["3f2a"] = { label: "work" };
    saveLabels(labels);
    expect(labelFor("3f2a")).toBe("work");
    expect(labelFor("nope")).toBeNull();
  });

  it("survives a corrupt labels file by starting empty", () => {
    mkdirSync(appDir(), { recursive: true });
    writeFileSync(path.join(appDir(), "labels.json"), "not json at all");
    expect(loadLabels()).toEqual({ instances: {} });
  });
});
