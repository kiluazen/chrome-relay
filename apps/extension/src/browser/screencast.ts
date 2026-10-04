// Background recording samples Page.captureScreenshot rather than depending
// on compositor events, which stop when a tab is covered or backgrounded.
// Capture never selects a tab, raises a window, or moves the user's pointer.
import { RelayError, TOOL_NAMES } from "@chrome-relay/protocol";
import { send } from "./cdp";

export interface ScreencastFrame {
  data: string;
  timestamp: number;
  width: number;
  height: number;
}

export interface StartOptions {
  format?: "jpeg" | "png";
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

interface TabSession {
  frames: ScreencastFrame[];
  startedAt: number;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  captureError?: string;
}

const sessions = new Map<number, TabSession>();

// Read encoded dimensions without allocating a decoded pixel buffer for
// every unscaled frame. Unknown headers fall back to the browser decoder.
function encodedSize(bytes: Uint8Array, format: "jpeg" | "png"): { width: number; height: number } | undefined {
  if (format === "png" && bytes.length >= 24 && bytes[0] === 137 &&
      String.fromCharCode(...bytes.subarray(1, 4)) === "PNG" &&
      String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (format !== "jpeg" || bytes[0] !== 255 || bytes[1] !== 216) return;
  for (let pos = 2; pos < bytes.length;) {
    if (bytes[pos++] !== 255) return;
    while (bytes[pos] === 255) pos++;
    const marker = bytes[pos++];
    if (marker === 217 || marker === 218) return;
    if (marker === 1 || (marker >= 208 && marker <= 216)) continue;
    if (pos + 1 >= bytes.length) return;
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) return;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker) && length >= 8) {
      return { height: (bytes[pos + 3] << 8) | bytes[pos + 4], width: (bytes[pos + 5] << 8) | bytes[pos + 6] };
    }
    pos += length;
  }
}

async function captureFrame(tabId: number, opts: StartOptions): Promise<ScreencastFrame> {
  const format = opts.format ?? "jpeg";
  const { data } = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality: opts.quality ?? 80 } : {}),
    captureBeyondViewport: false
  });
  const timestamp = Date.now() / 1000;
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const size = encodedSize(bytes, format);
  if (size && size.width > 0 && size.height > 0 &&
      (!opts.maxWidth || size.width <= opts.maxWidth) && (!opts.maxHeight || size.height <= opts.maxHeight)) {
    return { data, timestamp, ...size };
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${format}` }));
  try {
    const scale = Math.min(1, (opts.maxWidth ?? bitmap.width) / bitmap.width,
      (opts.maxHeight ?? bitmap.height) / bitmap.height);
    const width = Math.max(1, Math.floor(bitmap.width * scale));
    const height = Math.max(1, Math.floor(bitmap.height * scale));
    if (scale === 1) return { data, timestamp, width, height };
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: (opts.quality ?? 80) / 100 });
    const scaled = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < scaled.length; i += 8192) {
      binary += String.fromCharCode(...scaled.subarray(i, i + 8192));
    }
    return { data: btoa(binary), timestamp, width, height };
  } finally {
    bitmap.close();
  }
}

export async function startScreencast(tabId: number, opts: StartOptions = {}): Promise<{
  started: boolean; mode: "sampled"; intervalMs: number;
}> {
  if (sessions.has(tabId)) {
    throw new RelayError({
      code: "invalid_arguments",
      message: `Screencast already running on tab ${tabId}. Call screencast stop --tab ${tabId} first.`,
      tool: TOOL_NAMES.SCREENCAST, phase: "start_screencast", details: { tabId }, retryable: false
    });
  }
  const session: TabSession = { frames: [], startedAt: Date.now(), stopped: false };
  sessions.set(tabId, session);
  const intervalMs = Math.round(1000 / 15 * (opts.everyNthFrame ?? 1));
  const capture = async () => {
    const frame = await captureFrame(tabId, opts);
    if (!session.stopped) session.frames.push(frame);
  };
  const tick = async () => {
    const started = Date.now();
    session.pending = capture();
    try {
      await session.pending;
    } catch (error) {
      session.captureError = error instanceof Error ? error.message : String(error);
      session.stopped = true;
    }
    if (!session.stopped) session.timer = setTimeout(tick, Math.max(0, intervalMs - (Date.now() - started)));
  };
  try {
    session.pending = capture();
    await session.pending;
    if (!session.stopped) session.timer = setTimeout(tick, intervalMs);
  } catch (error) {
    session.stopped = true;
    sessions.delete(tabId);
    throw error;
  }
  return { started: true, mode: "sampled", intervalMs };
}

export async function stopScreencast(tabId: number): Promise<{
  frameCount: number; durationMs: number; frames: ScreencastFrame[]; mode: "sampled"; captureError?: string;
}> {
  const session = sessions.get(tabId);
  if (!session) {
    throw new RelayError({
      code: "target_not_found", message: `No screencast running on tab ${tabId}.`,
      tool: TOOL_NAMES.SCREENCAST, phase: "stop_screencast", details: { tabId }, retryable: false
    });
  }
  session.stopped = true;
  if (session.timer) clearTimeout(session.timer);
  await session.pending?.catch(() => {});
  sessions.delete(tabId);
  return {
    frameCount: session.frames.length, durationMs: Date.now() - session.startedAt,
    frames: session.frames, mode: "sampled",
    ...(session.captureError ? { captureError: session.captureError } : {})
  };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessions.get(tabId);
  if (!session) return;
  session.stopped = true;
  if (session.timer) clearTimeout(session.timer);
  sessions.delete(tabId);
});
