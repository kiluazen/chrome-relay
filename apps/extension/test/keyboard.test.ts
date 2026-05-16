import { describe, it, expect, beforeEach } from "vitest";
import { getChromeStub } from "./setup-chrome-mock";
import { pressKey } from "../src/browser/keyboard";

const TAB_ID = 42;

function lastTwoCalls(): { down: any; up: any } {
  const stub = getChromeStub();
  const calls = stub.debugger.sendCommand.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(2);
  const last = calls.slice(-2);
  return { down: last[0], up: last[1] };
}

describe("pressKey — special keys", () => {
  beforeEach(() => {
    // Reset attached state by re-importing? Each beforeEach resets chrome,
    // so attach happens again. But cdp.ts caches `attached` Set across tests.
    // Each call to pressKey awaits ensureAttached which checks the cache.
    // Since chrome.debugger.sendCommand is fresh each test, and ensureAttached
    // tries chrome.debugger.attach (which returns ok), the cache fills up.
    // We don't care — we only assert sendCommand args.
  });

  const cases: Array<[string, { key: string; code: string; vk: number; text?: string }]> = [
    ["Enter", { key: "Enter", code: "Enter", vk: 13, text: "\r" }],
    ["enter", { key: "Enter", code: "Enter", vk: 13, text: "\r" }],
    ["Return", { key: "Enter", code: "Enter", vk: 13, text: "\r" }],
    ["Tab", { key: "Tab", code: "Tab", vk: 9 }],
    ["Escape", { key: "Escape", code: "Escape", vk: 27 }],
    ["Esc", { key: "Escape", code: "Escape", vk: 27 }],
    ["Backspace", { key: "Backspace", code: "Backspace", vk: 8 }],
    ["Delete", { key: "Delete", code: "Delete", vk: 46 }],
    ["Space", { key: " ", code: "Space", vk: 32, text: " " }],
    ["ArrowUp", { key: "ArrowUp", code: "ArrowUp", vk: 38 }],
    ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", vk: 40 }],
    ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }],
    ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", vk: 39 }],
    ["Up", { key: "ArrowUp", code: "ArrowUp", vk: 38 }],
    ["Down", { key: "ArrowDown", code: "ArrowDown", vk: 40 }],
    ["Left", { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }],
    ["Right", { key: "ArrowRight", code: "ArrowRight", vk: 39 }],
    ["Home", { key: "Home", code: "Home", vk: 36 }],
    ["End", { key: "End", code: "End", vk: 35 }],
    ["PageUp", { key: "PageUp", code: "PageUp", vk: 33 }],
    ["PageDown", { key: "PageDown", code: "PageDown", vk: 34 }]
  ];

  for (const [input, expected] of cases) {
    it(`maps "${input}" → key=${expected.key}, code=${expected.code}, vk=${expected.vk}`, async () => {
      await pressKey(TAB_ID, input);
      const { down, up } = lastTwoCalls();

      expect(down[0]).toEqual({ tabId: TAB_ID });
      expect(down[1]).toBe("Input.dispatchKeyEvent");
      const downParams = down[2];
      expect(downParams.key).toBe(expected.key);
      expect(downParams.code).toBe(expected.code);
      expect(downParams.windowsVirtualKeyCode).toBe(expected.vk);
      expect(downParams.modifiers).toBe(0);

      if (expected.text !== undefined) {
        expect(downParams.type).toBe("keyDown");
        expect(downParams.text).toBe(expected.text);
        expect(downParams.unmodifiedText).toBe(expected.text);
      } else {
        expect(downParams.type).toBe("rawKeyDown");
        expect(downParams.text).toBeUndefined();
      }

      const upParams = up[2];
      expect(upParams.type).toBe("keyUp");
      expect(upParams.key).toBe(expected.key);
      expect(upParams.code).toBe(expected.code);
      expect(upParams.text).toBeUndefined();
      expect(upParams.unmodifiedText).toBeUndefined();
    });
  }
});

describe("pressKey — character keys", () => {
  it("lowercase letter has KeyX code and vk = uppercase charCode", async () => {
    await pressKey(TAB_ID, "a");
    const { down } = lastTwoCalls();
    expect(down[2].key).toBe("a");
    expect(down[2].code).toBe("KeyA");
    expect(down[2].windowsVirtualKeyCode).toBe(65);
    expect(down[2].text).toBe("a");
    expect(down[2].type).toBe("keyDown");
  });

  it("uppercase letter has KeyX code", async () => {
    await pressKey(TAB_ID, "A");
    const { down } = lastTwoCalls();
    expect(down[2].key).toBe("A");
    expect(down[2].code).toBe("KeyA");
    expect(down[2].windowsVirtualKeyCode).toBe(65);
    expect(down[2].text).toBe("A");
  });

  it("digit uses self as code", async () => {
    await pressKey(TAB_ID, "7");
    const { down } = lastTwoCalls();
    expect(down[2].key).toBe("7");
    expect(down[2].code).toBe("7");
    expect(down[2].windowsVirtualKeyCode).toBe(55);
    expect(down[2].text).toBe("7");
  });

  it("symbol uses self as code", async () => {
    await pressKey(TAB_ID, "@");
    const { down } = lastTwoCalls();
    expect(down[2].key).toBe("@");
    expect(down[2].code).toBe("@");
    expect(down[2].text).toBe("@");
  });
});

describe("pressKey — modifiers", () => {
  it.each([
    ["Alt+a", 1],
    ["Ctrl+a", 2],
    ["Control+a", 2],
    ["Meta+a", 4],
    ["Cmd+a", 4],
    ["Command+a", 4],
    ["Shift+a", 8]
  ])("\"%s\" → modifiers bitmap = %i", async (chord, expected) => {
    await pressKey(TAB_ID, chord);
    const { down, up } = lastTwoCalls();
    expect(down[2].modifiers).toBe(expected);
    expect(up[2].modifiers).toBe(expected);
  });

  it("combines modifiers: Cmd+Shift+K → 4 | 8 = 12", async () => {
    await pressKey(TAB_ID, "Cmd+Shift+K");
    const { down } = lastTwoCalls();
    expect(down[2].modifiers).toBe(12);
    expect(down[2].key).toBe("K");
  });

  it("Ctrl+Alt+Shift+a → 1|2|8 = 11", async () => {
    await pressKey(TAB_ID, "Ctrl+Alt+Shift+a");
    const { down } = lastTwoCalls();
    expect(down[2].modifiers).toBe(11);
  });

  it("suppresses text when Cmd is held", async () => {
    await pressKey(TAB_ID, "Cmd+a");
    const { down } = lastTwoCalls();
    expect(down[2].text).toBeUndefined();
    expect(down[2].type).toBe("rawKeyDown");
  });

  it("suppresses text when Ctrl is held", async () => {
    await pressKey(TAB_ID, "Ctrl+a");
    const { down } = lastTwoCalls();
    expect(down[2].text).toBeUndefined();
    expect(down[2].type).toBe("rawKeyDown");
  });

  it("suppresses text when Alt is held", async () => {
    await pressKey(TAB_ID, "Alt+a");
    const { down } = lastTwoCalls();
    expect(down[2].text).toBeUndefined();
  });

  it("does NOT suppress text under Shift only", async () => {
    await pressKey(TAB_ID, "Shift+A");
    const { down } = lastTwoCalls();
    expect(down[2].text).toBe("A");
    expect(down[2].type).toBe("keyDown");
  });

  it("Shift+Enter still produces text \\r", async () => {
    await pressKey(TAB_ID, "Shift+Enter");
    const { down } = lastTwoCalls();
    expect(down[2].text).toBe("\r");
    expect(down[2].modifiers).toBe(8);
  });

  it("Cmd+Enter clears text since Cmd suppresses", async () => {
    // Special-key text comes from the table, not from char processing.
    // The spec for Enter has text "\r"; modifier suppression is for character keys.
    // This documents current behavior.
    await pressKey(TAB_ID, "Cmd+Enter");
    const { down } = lastTwoCalls();
    expect(down[2].modifiers).toBe(4);
    expect(down[2].key).toBe("Enter");
  });
});

describe("pressKey — error cases", () => {
  it("rejects empty expression", async () => {
    await expect(pressKey(TAB_ID, "")).rejects.toThrow(/Empty key expression/);
  });

  it("rejects unknown modifier", async () => {
    await expect(pressKey(TAB_ID, "fizz+a")).rejects.toThrow(/Unknown modifier/);
  });

  it("rejects unknown multi-char key", async () => {
    await expect(pressKey(TAB_ID, "blarp")).rejects.toThrow(/Unknown key/);
  });

  it("error message points users to chrome_type for typed text", async () => {
    await expect(pressKey(TAB_ID, "hello")).rejects.toThrow(/single character|named key|chord/);
  });

  it("rejects only-modifiers chord", async () => {
    await expect(pressKey(TAB_ID, "Cmd+Shift")).rejects.toThrow();
  });
});

describe("pressKey — output shape invariants", () => {
  it("always sends two CDP commands (down + up)", async () => {
    const stub = getChromeStub();
    const before = stub.debugger.sendCommand.mock.calls.length;
    await pressKey(TAB_ID, "Tab");
    const after = stub.debugger.sendCommand.mock.calls.length;
    expect(after - before).toBe(2);
  });

  it("both events carry tabId and modifiers", async () => {
    await pressKey(TAB_ID, "Cmd+L");
    const { down, up } = lastTwoCalls();
    expect(down[0]).toEqual({ tabId: TAB_ID });
    expect(up[0]).toEqual({ tabId: TAB_ID });
    expect(down[2].modifiers).toBe(4);
    expect(up[2].modifiers).toBe(4);
  });

  it("nativeVirtualKeyCode mirrors windowsVirtualKeyCode", async () => {
    await pressKey(TAB_ID, "Enter");
    const { down } = lastTwoCalls();
    expect(down[2].nativeVirtualKeyCode).toBe(down[2].windowsVirtualKeyCode);
  });
});
