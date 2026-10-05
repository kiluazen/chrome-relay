import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getChromeStub } from "./setup-chrome-mock";

vi.mock("../src/browser/cdp", () => ({ send: vi.fn() }));

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 2, close: vi.fn() })));
  const { send } = await import("../src/browser/cdp");
  vi.mocked(send).mockReset().mockResolvedValue({ data: "YQ==" });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("background recording lifecycle", () => {
  it("stop cancels future captures and permits a new recording", async () => {
    const { startScreencast, stopScreencast } = await import("../src/browser/screencast");
    const { send } = await import("../src/browser/cdp");
    await startScreencast(42);
    const result = await stopScreencast(42);
    expect(result.frameCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    await startScreencast(42);
    await stopScreencast(42);
  });

  it("a failed initial capture releases the session for retry", async () => {
    const { startScreencast, stopScreencast } = await import("../src/browser/screencast");
    const { send } = await import("../src/browser/cdp");
    vi.mocked(send).mockRejectedValueOnce(new Error("capture unavailable"));
    await expect(startScreencast(42)).rejects.toThrow("capture unavailable");
    expect(vi.getTimerCount()).toBe(0);
    await startScreencast(42);
    await stopScreencast(42);
  });

  it("a later capture failure stops sampling and preserves the partial result", async () => {
    const { startScreencast, stopScreencast } = await import("../src/browser/screencast");
    const { send } = await import("../src/browser/cdp");
    await startScreencast(42);
    vi.mocked(send).mockRejectedValueOnce(new Error("target disconnected"));
    await vi.advanceTimersByTimeAsync(67);
    const result = await stopScreencast(42);
    expect(result).toMatchObject({ frameCount: 1, captureError: "target disconnected" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop waits for an in-flight capture without buffering it or scheduling another", async () => {
    const { startScreencast, stopScreencast } = await import("../src/browser/screencast");
    const { send } = await import("../src/browser/cdp");
    await startScreencast(42);
    let finish!: (frame: { data: string }) => void;
    vi.mocked(send).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.advanceTimersByTime(67);
    let stopped = false;
    const stopping = stopScreencast(42).then((result) => { stopped = true; return result; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish({ data: "YQ==" });
    expect((await stopping).frameCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("closing the tab cancels capture and releases its session", async () => {
    const { startScreencast, stopScreencast } = await import("../src/browser/screencast");
    const { send } = await import("../src/browser/cdp");
    await startScreencast(42);
    for (const listener of getChromeStub().tabs.onRemoved.listeners) listener(42);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(stopScreencast(42)).rejects.toMatchObject({ code: "target_not_found" });
  });
});


it.each([
  ["png", [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 128, 0, 0, 1, 224]],
  ["jpeg", [255, 216, 255, 224, 0, 4, 0, 0, 255, 194, 0, 8, 8, 1, 224, 2, 128, 0]]
] as const)("unscaled %s frames read dimensions without decoding pixels", async (format, header) => {
  const { startScreencast, stopScreencast } = await import("../src/browser/screencast");
  const { send } = await import("../src/browser/cdp");
  vi.mocked(send).mockResolvedValue({ data: btoa(String.fromCharCode(...header)) });
  await startScreencast(42, { format });
  const result = await stopScreencast(42);
  expect(result.frames[0]).toMatchObject({ width: 640, height: 480 });
  expect(createImageBitmap).not.toHaveBeenCalled();
});

it("--max-width renders the frame small in Chrome (clip.scale) instead of rescaling in the worker", async () => {
  const { startScreencast, stopScreencast } = await import("../src/browser/screencast");
  const { send } = await import("../src/browser/cdp");
  // A 1000x625 JPEG header: what Chrome returns for clip.scale at 2x DPR.
  const header = [255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 8, 8, 2, 113, 3, 232, 0];
  vi.mocked(send).mockImplementation(async (_tabId: number, method: string) => {
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 40 } };
    if (method === "Runtime.evaluate") return { result: { value: 2 } };
    return { data: btoa(String.fromCharCode(...header)) };
  });
  await startScreencast(42, { maxWidth: 1000 });
  const result = await stopScreencast(42);
  const capture = vi.mocked(send).mock.calls.find((c) => c[1] === "Page.captureScreenshot");
  expect(capture?.[2]).toMatchObject({ clip: { x: 0, y: 40, width: 1280, height: 800, scale: 1000 / 2560 } });
  expect(result.frames[0]).toMatchObject({ width: 1000, height: 625 });
  expect(createImageBitmap).not.toHaveBeenCalled();
});
