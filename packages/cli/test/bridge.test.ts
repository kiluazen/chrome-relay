import { describe, it, expect } from "vitest";
import { ExtensionBridge } from "../src/native/bridge";
import { compareSemver } from "../src/release-notes";

describe("ExtensionBridge.getExtensionVersion", () => {
  it("starts undefined and populates after bridge.ready", () => {
    const bridge = new ExtensionBridge(() => {});
    expect(bridge.getExtensionVersion()).toBeUndefined();

    bridge.handleMessage({
      type: "bridge.ready",
      payload: { extensionId: "abc", version: "0.6.0" }
    });

    expect(bridge.getExtensionVersion()).toBe("0.6.0");
  });

  it("supports the cli-outdated comparison used by the HTTP server", () => {
    const bridge = new ExtensionBridge(() => {});
    bridge.handleMessage({
      type: "bridge.ready",
      payload: { extensionId: "abc", version: "0.6.0" }
    });

    const cliVersion = "0.5.1";
    const extVersion = bridge.getExtensionVersion()!;
    expect(compareSemver(cliVersion, extVersion)).toBeLessThan(0); // notice fires

    // And the reverse — newer CLI than extension means no notice.
    expect(compareSemver("0.7.0", extVersion)).toBeGreaterThan(0);
  });
});
