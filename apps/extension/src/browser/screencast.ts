// Screencast — wraps CDP Page.startScreencast / Page.stopScreencast.
//
// Why screencast (vs the existing Page.captureScreenshot loop):
// captureScreenshot is a *pull*: you get whatever frame the compositor has
// committed at the moment of the call. Between two calls, Chrome can paint
// dozens of intermediate frames you never see — fade-ins, focus-ring fades,
// tooltip pop-ins, any CSS transition under ~300ms. startScreencast is a
// *push*: every compositor frame is shoved down the CDP channel, so the
// agent (or the recording) gets a paint-faithful timeline.
//
// IMPORTANT: screencast requires the tab to be ACTIVE. Chrome doesn't run
// paint loops on backgrounded tabs, so startScreencast on a non-active tab
// returns 0 frames. This is a real limitation, not a bug. Use chrome.tabs.
// update({active:true}) before starting if needed. (chrome_screenshot does
// work on backgrounded tabs — CDP forces a paint when you ask for one.)
//
// Buffering: frames stream in via chrome.debugger.onEvent (Page.screencastFrame)
// and we accumulate them per-tab until stopScreencast is called. Each frame
// must be ACK'd via Page.screencastFrameAck or the stream pauses. Frames
// are base64 JPEG strings, ~5-30 KB each at quality 80; a 10s capture at
// 15fps lands around 2-5 MB in SW memory. Acceptable. Dedupe happens in
// the CLI's screencast stop, after frames are written to disk — keeps the
// raw stream intact for callers that pass --no-dedupe.

import { ensureAttached, send } from "./cdp";

export interface ScreencastFrame {
  data: string;       // base64 JPEG (no data: URL prefix)
  timestamp: number;  // CDP wall-clock seconds (multiply by 1000 for ms)
  width: number;
  height: number;
}

interface TabSession {
  frames: ScreencastFrame[];
  listener: (source: chrome.debugger.Debuggee, method: string, params: unknown) => void;
  startedAt: number;
}

const sessions = new Map<number, TabSession>();

export interface StartOptions {
  format?: "jpeg" | "png";   // default jpeg (smaller)
  quality?: number;          // 0-100, jpeg only; default 80
  maxWidth?: number;         // cap; CDP picks aspect-preserving height
  maxHeight?: number;
  everyNthFrame?: number;    // throttle the stream; default 1
}

interface RawScreencastFrame {
  data: string;
  sessionId: number;
  metadata: {
    timestamp?: number;
    deviceWidth?: number;
    deviceHeight?: number;
  };
}

export async function startScreencast(tabId: number, opts: StartOptions = {}): Promise<{ started: boolean }> {
  if (sessions.has(tabId)) {
    throw new Error(
      `Screencast already running on tab ${tabId}. Call screencast stop --tab ${tabId} first.`
    );
  }
  await ensureAttached(tabId);
  await send(tabId, "Page.enable", {});

  const frames: ScreencastFrame[] = [];

  // Single chrome.debugger.onEvent listener per session. Routes Page.screencastFrame
  // for this tab into our buffer + ACKs to keep the stream flowing.
  const listener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
    if (source.tabId !== tabId) return;
    if (method !== "Page.screencastFrame") return;
    const frame = params as RawScreencastFrame;
    frames.push({
      data: frame.data,
      timestamp: frame.metadata?.timestamp ?? Date.now() / 1000,
      width: frame.metadata?.deviceWidth ?? 0,
      height: frame.metadata?.deviceHeight ?? 0
    });
    // Must ACK or CDP throttles us down to nothing within a second or two.
    send(tabId, "Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {
      // ACK failures usually mean the SW lost the debugger session — the
      // outer listener will be removed when stopScreencast runs; nothing to do here.
    });
  };
  chrome.debugger.onEvent.addListener(listener);

  await send(tabId, "Page.startScreencast", {
    format: opts.format ?? "jpeg",
    quality: opts.quality ?? 80,
    maxWidth: opts.maxWidth,
    maxHeight: opts.maxHeight,
    everyNthFrame: opts.everyNthFrame ?? 1
  });

  sessions.set(tabId, { frames, listener, startedAt: Date.now() });
  return { started: true };
}

export async function stopScreencast(tabId: number): Promise<{
  frameCount: number;
  durationMs: number;
  frames: ScreencastFrame[];
}> {
  const session = sessions.get(tabId);
  if (!session) {
    throw new Error(`No screencast running on tab ${tabId}.`);
  }
  try {
    await send(tabId, "Page.stopScreencast", {});
  } catch {
    // Tab may have closed; we still want to return whatever frames we buffered.
  }
  chrome.debugger.onEvent.removeListener(session.listener);
  sessions.delete(tabId);
  return {
    frameCount: session.frames.length,
    durationMs: Date.now() - session.startedAt,
    frames: session.frames
  };
}

// Auto-clean on tab close — leftover sessions would leak the listener.
chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessions.get(tabId);
  if (!session) return;
  chrome.debugger.onEvent.removeListener(session.listener);
  sessions.delete(tabId);
});
