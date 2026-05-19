// 0.5.17 — force-visible on attach.
//
// Verifies the three CDP calls fire on attach: setWebLifecycleState +
// addScriptToEvaluateOnNewDocument + Runtime.evaluate (for the current
// document). Each is best-effort — if Chrome refuses (chrome:// pages,
// the Web Store), attach should still succeed.

import { describe, it, expect, beforeEach } from "vitest";
import { getChromeStub } from "./setup-chrome-mock";
import { ensureAttached, _setForceVisibilityEnabledForTests } from "../src/browser/cdp";

beforeEach(() => {
  // Re-enable for these tests only — the global setup turned it off.
  _setForceVisibilityEnabledForTests(true);
});

describe("force-visibility on attach", () => {
  it("calls Page.setWebLifecycleState({state:'active'}) after attach", async () => {
    const stub = getChromeStub();
    await ensureAttached(700);

    const lifecycleCall = stub.debugger.sendCommand.mock.calls.find(
      ([_, method]) => method === "Page.setWebLifecycleState"
    );
    expect(lifecycleCall).toBeDefined();
    expect(lifecycleCall![2]).toEqual({ state: "active" });
  });

  it("injects a visibility-override script via Page.addScriptToEvaluateOnNewDocument", async () => {
    const stub = getChromeStub();
    await ensureAttached(701);

    const scriptCall = stub.debugger.sendCommand.mock.calls.find(
      ([_, method]) => method === "Page.addScriptToEvaluateOnNewDocument"
    );
    expect(scriptCall).toBeDefined();
    const source = scriptCall![2].source as string;
    expect(source).toContain("visibilityState");
    expect(source).toContain("\"visible\"");
    expect(source).toContain("__chrome_relay_visibility_patched__");
  });

  it("also patches the currently-loaded document via Runtime.evaluate", async () => {
    const stub = getChromeStub();
    await ensureAttached(702);

    const evalCall = stub.debugger.sendCommand.mock.calls.find(
      ([_, method, params]) =>
        method === "Runtime.evaluate" &&
        typeof params?.expression === "string" &&
        params.expression.includes("__chrome_relay_visibility_patched__")
    );
    expect(evalCall).toBeDefined();
  });

  it("attach succeeds even when force-visibility CDP calls fail", async () => {
    const stub = getChromeStub();
    // Simulate "Cannot access a chrome:// URL" failure on every shim call.
    stub.debugger.sendCommand.mockImplementation(async (_t, method) => {
      if (
        method === "Page.setWebLifecycleState" ||
        method === "Page.addScriptToEvaluateOnNewDocument" ||
        method === "Runtime.evaluate"
      ) {
        throw new Error("Cannot access a chrome:// URL");
      }
      return {};
    });

    await expect(ensureAttached(703)).resolves.toBeUndefined();
  });
});
