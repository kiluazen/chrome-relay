import { vi, beforeEach } from "vitest";

// jsdom's CSS object lacks `escape`. Polyfill matching the spec well enough.
if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.escape !== "function") {
  const escape = (value: string) =>
    String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => {
      const code = ch.charCodeAt(0);
      if (code === 0) return "�";
      return `\\${ch}`;
    });
  globalThis.CSS = { ...(globalThis.CSS ?? {}), escape } as typeof globalThis.CSS;
}


type ChromeStub = {
  debugger: {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    onDetach: { addListener: ReturnType<typeof vi.fn>; listeners: Array<(source: { tabId?: number }) => void> };
  };
  tabs: {
    onRemoved: { addListener: ReturnType<typeof vi.fn>; listeners: Array<(tabId: number) => void> };
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  windows: {
    update: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
  };
};

function makeChromeStub(): ChromeStub {
  const detachListeners: Array<(source: { tabId?: number }) => void> = [];
  const removedListeners: Array<(tabId: number) => void> = [];

  const stub: ChromeStub = {
    debugger: {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
      onDetach: {
        listeners: detachListeners,
        addListener: vi.fn((fn) => {
          detachListeners.push(fn);
        })
      }
    },
    tabs: {
      onRemoved: {
        listeners: removedListeners,
        addListener: vi.fn((fn) => {
          removedListeners.push(fn);
        })
      },
      get: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: 9999, windowId: 1 }),
      remove: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([])
    },
    windows: {
      update: vi.fn().mockResolvedValue({}),
      getAll: vi.fn().mockResolvedValue([])
    }
  };

  return stub;
}

(globalThis as unknown as { chrome: ChromeStub }).chrome = makeChromeStub();

beforeEach(() => {
  (globalThis as unknown as { chrome: ChromeStub }).chrome = makeChromeStub();
});

export function getChromeStub(): ChromeStub {
  return (globalThis as unknown as { chrome: ChromeStub }).chrome;
}
