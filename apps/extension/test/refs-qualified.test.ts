import { describe, it, expect, beforeEach, vi } from "vitest";
import { RelayError } from "@chrome-relay/protocol";

// Same in-memory chrome mock pattern as refs.test.ts — the RefMap module
// registers listeners and persists at import time, and identity.ts reads
// chrome.storage.local.

let store: Record<string, unknown>;
let localStore: Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  store = {};
  localStore = {};
  (globalThis as any).chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        })
      },
      local: {
        get: vi.fn(async (key: string) => ({ [key]: localStore[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(localStore, obj);
        })
      }
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() }
    }
  };
});

const INSTANCE_ID = "3f2a9c1e-0000-4000-8000-000000000000"; // prefix 3f2a

async function load() {
  const identity = await import("../src/browser/identity");
  identity.__setInstanceIdForTests(INSTANCE_ID);
  const refs = await import("../src/browser/refs");
  refs.resetRefMapForTests();
  return refs;
}

const entry = (tabId: number, backendNodeId: number) => ({
  tabId,
  backendNodeId,
  role: "button",
  name: "Send"
});

describe("profile-qualified ref resolution", () => {
  it("internal map stays bare; bare and own-prefix-qualified inputs both resolve", async () => {
    const refs = await load();
    const id = refs.allocateRef(entry(7, 101)); // "e1" internally
    expect(id).toBe("e1");
    expect(await refs.getRefEntry("e1")).toMatchObject({ tabId: 7, backendNodeId: 101 });
    expect(await refs.getRefEntry("3f2a:e1")).toMatchObject({ tabId: 7, backendNodeId: 101 });
  });

  it("a FOREIGN prefix throws target_conflict — not stale_ref", async () => {
    const refs = await load();
    refs.allocateRef(entry(7, 101));
    // Note: no instanceof — vi.resetModules() gives the dynamic import its
    // own copy of the protocol module, so class identity doesn't cross.
    await expect(refs.getRefEntry("91bc:e1")).rejects.toSatisfy((e: unknown) => {
      const err = e as RelayError;
      expect(err.name).toBe("RelayError");
      expect(err.code).toBe("target_conflict");
      expect(err.message).toContain("another profile");
      return true;
    });
  });

  it("healRefEntry normalizes qualified input to the same bare key", async () => {
    const refs = await load();
    refs.allocateRef(entry(7, 101));
    await refs.healRefEntry("3f2a:e1", 202);
    expect(await refs.getRefEntry("e1")).toMatchObject({ backendNodeId: 202 });
  });

  it("an unknown-but-own-prefixed ref resolves to undefined (stale), not an error", async () => {
    const refs = await load();
    expect(await refs.getRefEntry("3f2a:e99")).toBeUndefined();
  });
});
