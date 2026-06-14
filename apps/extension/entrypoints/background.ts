import { startNativeBridge } from "../src/bridge/native-host";
import { runTool } from "../src/browser/tools";

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
  // Web pages cannot reach this — service workers are isolated from page scripts.
  (globalThis as { __chromeRelay?: unknown }).__chromeRelay = { runTool };
});
