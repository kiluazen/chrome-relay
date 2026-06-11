// AX-node click support for the deprecated chrome_click_ax tool.
//
// getAxTree and the CompactAxNode tree used to live here; the unified
// snapshot (snapshot.ts, adoption-spec Change 1) replaced them — one tree,
// one ref space. chrome_ax now aliases to the snapshot builder, and
// chrome_click_ax remains only for callers holding raw backendDOMNodeIds.
// Ref-based clicks go through element.ts (resolveRefCenter), which also
// heals stale ids — this path deliberately does not.

import { RelayError, TOOL_NAMES } from "@chrome-relay/protocol";
import { send } from "./cdp";

// Click an AX node by its backendDOMNodeId. Uses CDP's box-model to get
// the click center, scrolls it into view, then sends a CDP mouse triple
// (move → press → release). Same trusted-click pattern chrome_click_element
// uses, but resolved from a stable DOM-level id instead of a CSS selector.
export async function clickAxNode(tabId: number, backendDOMNodeId: number): Promise<{ clicked: true; backendDOMNodeId: number; x: number; y: number }> {
  // Resolve the box; throws if the node is gone — explicit-failure per
  // design call #3 (no silent re-pull-and-retry).
  let boxModel: { content: number[]; width: number; height: number } | undefined;
  try {
    const resp = await send<{ model: { content: number[]; width: number; height: number } }>(
      tabId,
      "DOM.getBoxModel",
      { backendNodeId: backendDOMNodeId }
    );
    boxModel = resp.model;
  } catch (e) {
    throw new RelayError({
      code: "element_not_found",
      message: `AX node ${backendDOMNodeId} no longer exists or has no box. Re-run \`chrome-relay snapshot\` and click the @ref instead.`,
      tool: TOOL_NAMES.CLICK_AX,
      phase: "DOM.getBoxModel",
      details: { backendDOMNodeId, underlying: e instanceof Error ? e.message : String(e) },
      retryable: false
    });
  }
  if (!boxModel) {
    throw new RelayError({
      code: "element_not_found",
      message: `AX node ${backendDOMNodeId} returned no box model.`,
      tool: TOOL_NAMES.CLICK_AX,
      phase: "DOM.getBoxModel",
      details: { backendDOMNodeId },
      retryable: false
    });
  }

  // Scroll into view first — same reason chrome_click_element scrolls.
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: backendDOMNodeId });
    // Re-fetch the box after scroll — coordinates likely changed.
    const after = await send<{ model: { content: number[]; width: number; height: number } }>(
      tabId,
      "DOM.getBoxModel",
      { backendNodeId: backendDOMNodeId }
    );
    boxModel = after.model;
  } catch {
    // scrollIntoViewIfNeeded isn't available on every CDP target version;
    // proceed with the original coords.
  }

  // Content quad layout: [x1, y1, x2, y2, x3, y3, x4, y4] (clockwise from top-left).
  const q = boxModel.content;
  const x = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
  const y = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);

  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });

  return { clicked: true, backendDOMNodeId, x, y };
}
