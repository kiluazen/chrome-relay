import { describe, it, expect, beforeEach, vi } from "vitest";

// The deploy-skew gate: wire refs qualify ONLY after a v2 host says hello.
// An old host never sends bridge.hello, so a store-updated extension in
// front of an old CLI keeps minting bare refs the old parser accepts.

beforeEach(() => {
  vi.resetModules();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined)
      }
    }
  };
});

const INSTANCE_ID = "3f2a9c1e-0000-4000-8000-000000000000";

describe("getWireRefPrefix (deploy-skew gate)", () => {
  it("returns null before any hello — pre-v2 host, bare refs", async () => {
    const identity = await import("../src/browser/identity");
    identity.__setInstanceIdForTests(INSTANCE_ID);
    expect(await identity.getWireRefPrefix()).toBeNull();
  });

  it("returns null for a sub-v2 hello", async () => {
    const identity = await import("../src/browser/identity");
    identity.__setInstanceIdForTests(INSTANCE_ID);
    identity.setHostProtocolVersion(1);
    expect(await identity.getWireRefPrefix()).toBeNull();
  });

  it("returns the instance prefix once a v2 host says hello", async () => {
    const identity = await import("../src/browser/identity");
    identity.__setInstanceIdForTests(INSTANCE_ID);
    identity.setHostProtocolVersion(2);
    expect(await identity.getWireRefPrefix()).toBe("3f2a");
  });
});
