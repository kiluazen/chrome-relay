import { startNativeBridge } from "../src/bridge/native-host";
import { runTool } from "../src/browser/tools";

export default defineBackground(() => {
  startNativeBridge();
  // Exposed for E2E tests via Playwright service-worker `.evaluate()`.
  // Web pages cannot reach this — service workers are isolated from page scripts.
  (globalThis as { __chromeRelay?: unknown }).__chromeRelay = { runTool };
});
