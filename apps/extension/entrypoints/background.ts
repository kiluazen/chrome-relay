import { startNativeBridge } from "../src/bridge/native-host";
import { runTool } from "../src/browser/tools";
import { setHostProtocolVersion } from "../src/browser/identity";

const WELCOME_URL = "https://chrome-relay.kushalsm.com/welcome/";

export default defineBackground(() => {
  startNativeBridge();

  // First install lands the user on a welcome tab with the one prompt they
  // paste into their agent. Without this, "Add to Chrome" succeeds silently and
  // the user has no idea the CLI + bridge still need wiring. Only on install,
  // not on update/reload.
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      chrome.tabs.create({ url: WELCOME_URL });
    }
  });

  // Exposed for E2E tests via Playwright service-worker `.evaluate()`.
  // Web pages cannot reach this — service workers are isolated from page
  // scripts. simulateHello lets the e2e harness (which drives runTool
  // directly, no native host) act as a v2 host so qualified-ref paths are
  // exercised; the real hello arrives over native messaging in production.
  (globalThis as { __chromeRelay?: unknown }).__chromeRelay = {
    runTool,
    simulateHello: (protocolVersion: number) => setHostProtocolVersion(protocolVersion)
  };
});
