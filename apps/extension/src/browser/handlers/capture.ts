// Visual + structural capture handlers:
//   SCREENSHOT, READ_PAGE, AX, CLICK_AX, HOVER, SCREENCAST
//
// Also owns two screenshot-specific helpers: downscalePngToMaxEdge and
// parseBbox. They live here (vs. in target.ts) because nothing else uses
// them and keeping them next to the handler that calls them reads cleanly.

import {
  parseChromeAxArgs,
  parseChromeClickAxArgs,
  parseChromeGetArgs,
  parseChromeHoverArgs,
  parseChromeReadPageArgs,
  parseChromeScreencastArgs,
  parseChromeScreenshotArgs,
  parseChromeSnapshotArgs,
  RelayError,
  TOOL_NAMES
} from "@chrome-relay/protocol";
import { evalExpression, evalInTab, send } from "../cdp";
import { clickAxNode } from "../a11y";
import { mapPageError, resolveRefCenter, resolveRefObjectId } from "../element";
import { locateForClick } from "../page-actions";
import { buildSnapshot } from "../snapshot";
import { startScreencast, stopScreencast } from "../screencast";
import { resolveTarget, requireTabId, invalidArg, type ToolHandler } from "./target";

// Downscale a base64 PNG so its longer edge ≤ maxEdge. Uses OffscreenCanvas
// (available in MV3 service workers). Returns the original bytes unchanged
// if the image is already within the limit.
async function downscalePngToMaxEdge(
  base64Png: string,
  maxEdge: number
): Promise<{ data: string; from: { width: number; height: number }; to: { width: number; height: number } }> {
  const binary = atob(base64Png);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const fromW = bitmap.width, fromH = bitmap.height;
  const longer = Math.max(fromW, fromH);
  if (longer <= maxEdge) {
    bitmap.close();
    return { data: base64Png, from: { width: fromW, height: fromH }, to: { width: fromW, height: fromH } };
  }
  const scale = maxEdge / longer;
  const toW = Math.max(1, Math.round(fromW * scale));
  const toH = Math.max(1, Math.round(fromH * scale));
  const canvas = new OffscreenCanvas(toW, toH);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("OffscreenCanvas 2d context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, toW, toH);
  bitmap.close();
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const outBuf = await outBlob.arrayBuffer();
  const outBytes = new Uint8Array(outBuf);
  let outBin = "";
  for (let i = 0; i < outBytes.length; i += 8192) {
    outBin += String.fromCharCode.apply(null, Array.from(outBytes.subarray(i, i + 8192)));
  }
  return { data: btoa(outBin), from: { width: fromW, height: fromH }, to: { width: toW, height: toH } };
}

// Parse "x,y,w,h" → CDP clip object. Strict: rejects negative or non-numeric.
function parseBbox(spec: string): { x: number; y: number; width: number; height: number; scale: number } {
  const parts = spec.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    invalidArg(
      TOOL_NAMES.SCREENSHOT,
      `Invalid --bbox "${spec}". Expected x,y,width,height (positive numbers).`,
      "parse_bbox",
      { received: spec }
    );
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3], scale: 1 };
}

export const captureHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.SCREENSHOT](args) {
    const parsed = parseChromeScreenshotArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    const fullPage = parsed.fullPage === true;

    const params: Record<string, unknown> = {
      format: "png",
      captureBeyondViewport: fullPage
    };

    let clipMeta: { source: "bbox" | "selector"; selector?: string; padding?: number } | null = null;

    if (parsed.bbox) {
      const clip = parseBbox(parsed.bbox);
      params.clip = clip;
      params.captureBeyondViewport = true;
      clipMeta = { source: "bbox" };
    } else if (parsed.selector) {
      const padding = parsed.padding ?? 0;
      const rect = await evalInTab(tabId, locateForClick, [parsed.selector]).catch((e) =>
        mapPageError(e, TOOL_NAMES.SCREENSHOT, "locate_element")
      );
      const clip = {
        x: Math.max(0, rect.x - rect.width / 2 - padding),
        y: Math.max(0, rect.y - rect.height / 2 - padding),
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
        scale: 1
      };
      params.clip = clip;
      params.captureBeyondViewport = true;
      clipMeta = { source: "selector", selector: parsed.selector, padding };
    }

    const result = await send<{ data: string }>(tabId, "Page.captureScreenshot", params);

    let outData = result.data;
    let downscaled: { from: { width: number; height: number }; to: { width: number; height: number } } | null = null;
    if (parsed.maxEdge && parsed.maxEdge > 0) {
      const ds = await downscalePngToMaxEdge(result.data, parsed.maxEdge);
      outData = ds.data;
      if (ds.from.width !== ds.to.width || ds.from.height !== ds.to.height) {
        downscaled = { from: ds.from, to: ds.to };
      }
    }

    return {
      tabId,
      windowId: tab.windowId,
      dataUrl: `data:image/png;base64,${outData}`,
      ...(clipMeta ? { clip: clipMeta } : {}),
      ...(downscaled ? { downscaled } : {})
    };
  },

  // Unified page snapshot (adoption-spec Change 1) — AX tree + cursor-
  // interactive sweep, one ref space. Returns structured SnapshotData; the
  // CLI renders the compact text via the protocol renderer.
  async [TOOL_NAMES.SNAPSHOT](args) {
    const parsed = parseChromeSnapshotArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    return buildSnapshot(tabId, parsed);
  },

  // chrome_get (adoption-spec Change 6) — one value without a snapshot.
  // Plain { value } out; the CLI prints it bare.
  async [TOOL_NAMES.GET](args) {
    const parsed = parseChromeGetArgs(args);

    if (parsed.what === "title" || parsed.what === "url") {
      const tab = await resolveTarget(parsed);
      return { value: (parsed.what === "title" ? tab.title : tab.url) ?? "" };
    }

    if (parsed.what === "count") {
      const tab = await resolveTarget(parsed);
      const tabId = requireTabId(tab);
      const r = await evalExpression<number>(
        tabId,
        `document.querySelectorAll(${JSON.stringify(parsed.selector)}).length`
      );
      return { value: r.value ?? 0 };
    }

    // text | value | attr — by ref (objectId path) or by selector (in-page).
    const attrName = parsed.what === "attr" ? parsed.attrName : null;
    if (parsed.ref) {
      const r = await resolveRefObjectId(TOOL_NAMES.GET, parsed.ref, parsed);
      const resp = await send<{
        result: { value?: unknown };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>(r.tabId, "Runtime.callFunctionOn", {
        objectId: r.objectId,
        functionDeclaration: `function (what, attrName) {
          const el = this;
          if (what === "text") return (el.innerText ?? el.textContent ?? "").trim();
          if (what === "value") return "value" in el ? el.value : null;
          return el.getAttribute(attrName);
        }`,
        arguments: [{ value: parsed.what }, { value: attrName }],
        returnByValue: true
      });
      if (resp.exceptionDetails) {
        mapPageError(
          new Error(resp.exceptionDetails.exception?.description ?? resp.exceptionDetails.text),
          TOOL_NAMES.GET,
          "get_ref"
        );
      }
      return { value: resp.result.value ?? null };
    }

    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    const s = JSON.stringify(parsed.selector);
    try {
      const r = await evalExpression<unknown>(
        tabId,
        `(() => {
          const el = document.querySelector(${s});
          if (!el) throw new Error("Element not found for selector: " + ${s});
          const what = ${JSON.stringify(parsed.what)};
          if (what === "text") return (el.innerText ?? el.textContent ?? "").trim();
          if (what === "value") return "value" in el ? el.value : null;
          return el.getAttribute(${JSON.stringify(attrName)});
        })()`
      );
      return { value: r.value ?? null };
    } catch (e) {
      mapPageError(e, TOOL_NAMES.GET, "get_selector");
    }
  },

  // Deprecated aliases — both dispatch to the unified snapshot builder.
  // The OLD output formats are gone on purpose: keeping them would mean
  // keeping the old walker code in parallel (see
  // docs/adoption-spec-codebase-impact.md §4b). Removal: next minor.
  async [TOOL_NAMES.READ_PAGE](args) {
    const parsed = parseChromeReadPageArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    const data = await buildSnapshot(tabId, { interactiveOnly: parsed.interactiveOnly === true });
    return {
      ...data,
      deprecated: "chrome_read_page is deprecated — use chrome_snapshot. Output is the unified snapshot format."
    };
  },

  async [TOOL_NAMES.AX](args) {
    const parsed = parseChromeAxArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    const data = await buildSnapshot(tabId, { interactiveOnly: parsed.interactiveOnly === true });
    return {
      ...data,
      deprecated:
        "chrome_ax is deprecated — use chrome_snapshot. rootRole/includeSubframes are ignored (snapshot --scope replaces rootRole)."
    };
  },

  async [TOOL_NAMES.CLICK_AX](args) {
    const parsed = parseChromeClickAxArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    return clickAxNode(tabId, parsed.node);
  },

  // Hover — dispatches mouseMoved at element center so :hover/:focus-within
  // styles fire. Pair with screencast to capture micro-state animations.
  // Args parsed via protocol-owned parseChromeHoverArgs (PR 12).
  async [TOOL_NAMES.HOVER](args) {
    const parsed = parseChromeHoverArgs(args);
    if (parsed.kind === "ref") {
      const r = await resolveRefCenter(TOOL_NAMES.HOVER, parsed.ref, parsed);
      await send(r.tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: r.x,
        y: r.y,
        modifiers: 0,
        buttons: 0
      });
      return { hovered: true, x: r.x, y: r.y, ref: parsed.ref, tabId: r.tabId, ...(r.healed ? { healed: true } : {}) };
    }
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    let x: number;
    let y: number;
    if (parsed.kind === "coords") {
      x = parsed.x;
      y = parsed.y;
    } else {
      const result = await evalExpression<{ x: number; y: number; w: number; h: number } | null>(
        tabId,
        `(() => { const el = document.querySelector(${JSON.stringify(parsed.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`
      );
      const rect = result.value;
      if (!rect) {
        throw new RelayError({
          code: "element_not_found",
          message: `chrome_hover: no element matches selector ${parsed.selector}`,
          tool: TOOL_NAMES.HOVER,
          phase: "locate_element",
          details: { selector: parsed.selector },
          retryable: false
        });
      }
      x = rect.x + rect.w / 2;
      y = rect.y + rect.h / 2;
    }
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x, y,
      modifiers: 0,
      buttons: 0
    });
    return { hovered: true, x, y, selector: parsed.kind === "selector" ? parsed.selector : null };
  },

  // Screencast — start/stop a CDP screencast stream. Frames are buffered
  // in the SW and returned on stop. Requires an active tab (Chrome doesn't
  // paint backgrounded tabs).
  async [TOOL_NAMES.SCREENCAST](args) {
    const parsed = parseChromeScreencastArgs(args);
    const tab = await resolveTarget(parsed);
    const tabId = requireTabId(tab);
    if (parsed.action === "stop") {
      return stopScreencast(tabId);
    }
    // parsed.action === "start"
    const opts: Parameters<typeof startScreencast>[1] = {};
    if (parsed.format)                  opts.format = parsed.format;
    if (parsed.quality !== undefined)   opts.quality = parsed.quality;
    if (parsed.maxWidth !== undefined)  opts.maxWidth = parsed.maxWidth;
    if (parsed.maxHeight !== undefined) opts.maxHeight = parsed.maxHeight;
    if (parsed.everyNthFrame !== undefined) opts.everyNthFrame = parsed.everyNthFrame;
    return startScreencast(tabId, opts);
  }
};
