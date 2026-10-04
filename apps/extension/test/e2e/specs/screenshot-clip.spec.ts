import { test, expect } from "../helpers/extension-context";

// screenshot --selector on an element below the fold: the clip must be in
// document coordinates. A viewport-relative clip captured blank page.

test("selector screenshot below the fold captures the element itself", async ({ runTool, openFixture, serviceWorker }) => {
  const { tabId } = await openFixture("screenshot-clip.html");
  const shot = await runTool<{ dataUrl: string }>("chrome_screenshot", { tabId, selector: "#red" });
  const pixel = await serviceWorker.evaluate(async (dataUrl: string) => {
    const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const g = canvas.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, rgb: Array.from(g.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data).slice(0, 3) };
  }, shot.dataUrl);
  expect(pixel.w).toBe(200);
  expect(pixel.h).toBe(100);
  expect(pixel.rgb).toEqual([255, 0, 0]);
});
