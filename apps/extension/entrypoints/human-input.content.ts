// Tells the extension when the person is typing, clicking or scrolling in
// this tab, so agent input waits for them (src/browser/human.ts). Sends no
// page content: just "input happened here", at most a few times a second.

const HUMAN_INPUT_MESSAGE = "chrome-relay.human-input";
const THROTTLE_MS = 250;

export default defineContentScript({
  matches: ["<all_urls>"],
  allFrames: true,
  matchAboutBlank: true,
  runAt: "document_start",
  main() {
    let lastSent = 0;
    const report = (e: Event) => {
      if (!e.isTrusted) return;
      const now = Date.now();
      if (now - lastSent < THROTTLE_MS) return;
      lastSent = now;
      try {
        if (!chrome.runtime?.id) return; // extension reloaded; this copy is orphaned
        void chrome.runtime.sendMessage({ type: HUMAN_INPUT_MESSAGE }).catch(() => {});
      } catch {
        /* context invalidated */
      }
    };
    for (const type of ["keydown", "pointerdown", "wheel"]) {
      window.addEventListener(type, report, { capture: true, passive: true });
    }
  }
});
