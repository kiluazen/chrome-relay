import { describe, it, expect, expectTypeOf } from "vitest";
import {
  TOOL_NAMES,
  DEFAULT_HTTP_PORT,
  NATIVE_HOST_NAME,
  CHROME_WEB_STORE_EXTENSION_ID,
  DEFAULT_EXTENSION_ID,
  DEFAULT_EXTENSION_IDS,
  type ToolName,
  type LocalBridgeCallRequest,
  type BridgeMessage,
  type BridgeResponse
} from "../src/index";

describe("TOOL_NAMES", () => {
  it("exposes the expected stable tool surface", () => {
    expect(Object.keys(TOOL_NAMES).sort()).toEqual([
      "AX",
      "CLICK",
      "CLICK_AX",
      "CLOSE_TABS",
      "CONSOLE",
      "EVALUATE",
      "FILL",
      "GET_WINDOWS_AND_TABS",
      "GROUP",
      "HOVER",
      "KEYBOARD",
      "NAVIGATE",
      "NETWORK",
      "READ_PAGE",
      "SCREENCAST",
      "SCREENSHOT",
      "SELF_RELOAD",
      "SWITCH_TAB",
      "TYPE",
      "VIEWPORT",
      "WORKSPACE"
    ]);
  });

  it("each value is a kebab/snake-style string identifier", () => {
    for (const value of Object.values(TOOL_NAMES)) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it("values are unique", () => {
    const values = Object.values(TOOL_NAMES);
    expect(new Set(values).size).toBe(values.length);
  });

  it("TOOL_NAMES is readonly at the type level", () => {
    // Compile-time only — `as const` on TOOL_NAMES gives literal types.
    expectTypeOf(TOOL_NAMES.SCREENSHOT).toEqualTypeOf<"chrome_screenshot">();
    expectTypeOf(TOOL_NAMES.EVALUATE).toEqualTypeOf<"chrome_evaluate">();
    expectTypeOf(TOOL_NAMES.TYPE).toEqualTypeOf<"chrome_type">();
  });
});

describe("ToolName", () => {
  it("includes every TOOL_NAMES value as a literal union member", () => {
    expectTypeOf<ToolName>().toEqualTypeOf<(typeof TOOL_NAMES)[keyof typeof TOOL_NAMES]>();
  });
});

describe("transport constants", () => {
  it("DEFAULT_HTTP_PORT is the documented localhost port", () => {
    expect(DEFAULT_HTTP_PORT).toBe(12122);
    expect(typeof DEFAULT_HTTP_PORT).toBe("number");
  });

  it("NATIVE_HOST_NAME matches the installed manifest name", () => {
    expect(NATIVE_HOST_NAME).toBe("dev.chrome_relay.native_host");
  });
});

describe("extension IDs", () => {
  it("CHROME_WEB_STORE_EXTENSION_ID is a 32-char a-p extension id", () => {
    expect(CHROME_WEB_STORE_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it("DEFAULT_EXTENSION_ID equals the Chrome Web Store id", () => {
    expect(DEFAULT_EXTENSION_ID).toBe(CHROME_WEB_STORE_EXTENSION_ID);
  });

  it("DEFAULT_EXTENSION_IDS contains web store + legacy + local unpacked", () => {
    expect(DEFAULT_EXTENSION_IDS).toHaveLength(3);
    expect(DEFAULT_EXTENSION_IDS).toContain(CHROME_WEB_STORE_EXTENSION_ID);
    for (const id of DEFAULT_EXTENSION_IDS) {
      expect(id).toMatch(/^[a-p]{32}$/);
    }
  });
});

describe("LocalBridgeCallRequest shape", () => {
  it("requires name, allows optional args", () => {
    const req: LocalBridgeCallRequest = { name: TOOL_NAMES.SCREENSHOT };
    const reqWithArgs: LocalBridgeCallRequest = {
      name: TOOL_NAMES.NAVIGATE,
      args: { url: "https://example.com" }
    };
    expect(req.name).toBe("chrome_screenshot");
    expect(reqWithArgs.args).toEqual({ url: "https://example.com" });
  });
});

describe("BridgeResponse discriminated union", () => {
  it("ok=true carries data", () => {
    const ok: BridgeResponse = { ok: true, data: { foo: 1 } };
    if (ok.ok) {
      expectTypeOf(ok.data).toBeUnknown();
    }
  });

  it("ok=false carries error string", () => {
    const err: BridgeResponse = { ok: false, error: "boom" };
    if (!err.ok) {
      expectTypeOf(err.error).toBeString();
    }
  });
});

describe("BridgeMessage union", () => {
  it("includes ready, ping, pong, tool.call, tool.result", () => {
    const messages: BridgeMessage[] = [
      { type: "bridge.ready", payload: { extensionId: "x", version: "1" } },
      { type: "bridge.ping", id: "1" },
      { type: "bridge.pong", id: "1" },
      {
        type: "tool.call",
        id: "1",
        payload: { name: TOOL_NAMES.SCREENSHOT, args: {} }
      },
      {
        type: "tool.result",
        id: "1",
        payload: { ok: true, data: {} }
      }
    ];
    expect(messages).toHaveLength(5);
    for (const msg of messages) {
      expect(typeof msg.type).toBe("string");
    }
  });
});
