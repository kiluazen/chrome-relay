// Ref → element resolution for actions (adoption-spec Change 2).
//
// Resolution path per action:
//   1. Fast path: cached backendNodeId → DOM.resolveNode → in-page locate
//      (scroll if needed, client-rect center, hit test). Resolving and
//      locating the node IS the staleness verification — never skipped.
//   2. Stale path: node gone → re-query the AX tree by role+name+nth,
//      HEAL the map entry (our addition — agent-browser re-finds every
//      time), and retry the box.
//   3. Genuinely dead → stale_ref with the re-run-snapshot hint.
//
// Tab safety: a ref carries its tabId. Bare `click @e3` acts on the tab
// that produced e3 — never the active tab. A contradicting --tab /
// --workspace / --group is target_conflict, not a wrong-tab click.

import { RelayError, type ToolName, type SnapshotRefEntry, type TargetArgs } from "@chrome-relay/protocol";
import { send } from "./cdp";
import { getRefEntry, healRefEntry } from "./refs";
import { findBackendNodeByRoleName } from "./snapshot";

export interface ResolvedRef {
  tabId: number;
  backendNodeId: number;
  entry: SnapshotRefEntry;
  healed: boolean;
}

function staleRef(tool: ToolName, ref: string, reason: string): RelayError {
  return new RelayError({
    code: "stale_ref",
    message: `${tool}: @${ref} ${reason}. Re-run \`chrome-relay snapshot\` and use a fresh ref.`,
    tool,
    phase: "resolve_ref",
    details: { ref },
    retryable: false
  });
}

/** Look up a ref, enforce tab safety, verify the tab still exists. */
export async function resolveRefTarget(
  tool: ToolName,
  ref: string,
  target: TargetArgs
): Promise<SnapshotRefEntry> {
  const entry = await getRefEntry(ref);
  if (!entry) {
    throw staleRef(tool, ref, "is not a known ref (no snapshot produced it, or its tab was re-snapshotted)");
  }
  if (target.tabId !== undefined && target.tabId !== entry.tabId) {
    throw new RelayError({
      code: "target_conflict",
      message: `${tool}: @${ref} belongs to tab ${entry.tabId} but --tab ${target.tabId} was passed. Refs carry their own tab — drop --tab or use a ref from that tab's snapshot.`,
      tool,
      phase: "resolve_ref",
      details: { ref, refTabId: entry.tabId, requestedTabId: target.tabId },
      retryable: false
    });
  }
  if (target.workspaceName || target.groupName) {
    throw new RelayError({
      code: "target_conflict",
      message: `${tool}: @${ref} carries its own tab — --workspace/--group cannot be combined with a ref.`,
      tool,
      phase: "resolve_ref",
      details: { ref, refTabId: entry.tabId },
      retryable: false
    });
  }
  try {
    await chrome.tabs.get(entry.tabId);
  } catch {
    throw new RelayError({
      code: "target_not_found",
      message: `${tool}: the tab that produced @${ref} (tab ${entry.tabId}) is gone.`,
      tool,
      phase: "resolve_ref",
      details: { ref, tabId: entry.tabId },
      retryable: false
    });
  }
  return entry;
}

// In-page locate: scroll into view if needed, pick the click point from the
// element's own client rects, and (optionally) hit-test that point — all in
// one Runtime.callFunctionOn on the resolved node.
//
// Why in-page instead of DOM.getBoxModel + DOM.getNodeForLocation: measured
// on a scrolled background tab (HN's "More" link, after scrolling it into
// view), getNodeForLocation hit-tested the viewport point as if the page
// had not scrolled — it named a story link 500px up as the interceptor and
// refused a correct click, while document.elementFromPoint at the same
// point returned the link. Any ref below the fold could hit this. In-page
// it is also 2 CDP round trips instead of up to 7.
//
// Coordinates come back in main-frame viewport space: same-process iframe
// offsets are added walking up frameElement (OOPIFs are out of scope — CDP
// routes by tabId). Returns { noBox } for hidden/detached nodes, which the
// caller treats as stale (heal path), or { intercepted } naming the element
// that owns the point.
const LOCATE_FN = `function (hitTest) {
  const el = this;
  if (!el.isConnected) return { noBox: true };
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const root = el.getRootNode();
  const hitRoot = typeof root.elementFromPoint === "function" ? root : doc;
  const centerOf = () => {
    const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return null;
    const pts = rects.map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
    return pts.find((p) => p.x >= 0 && p.y >= 0 && p.x < view.innerWidth && p.y < view.innerHeight) || null;
  };
  const owner = (p) => {
    const hit = hitRoot.elementFromPoint(p.x, p.y);
    return hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? hit : null;
  };
  const center = () => el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (Array.from(el.getClientRects()).every((r) => r.width === 0 || r.height === 0)) return { noBox: true };
  let p = centerOf();
  if (!p) { center(); p = centerOf(); }
  if (!p) return { noBox: true };
  let blocker = hitTest ? owner(p) : null;
  if (blocker) {
    // A sticky header or a nested scroller often covers an element that is
    // merely near an edge: center it once before calling it intercepted.
    center();
    p = centerOf() || p;
    blocker = owner(p);
  }
  let x = p.x, y = p.y;
  for (let w = view; w !== w.top; w = w.parent) {
    let frame;
    try { frame = w.frameElement; } catch (e) { frame = null; }
    if (!frame) break;
    const fr = frame.getBoundingClientRect();
    x += fr.left + frame.clientLeft;
    y += fr.top + frame.clientTop;
  }
  if (blocker) {
    const attrs = [];
    for (const a of Array.from(blocker.attributes).slice(0, 6)) attrs.push(a.name, a.value.slice(0, 200));
    return { x: Math.round(x), y: Math.round(y), intercepted: { nodeName: blocker.nodeName, attributes: attrs } };
  }
  return { x: Math.round(x), y: Math.round(y) };
}`;

interface LocateResult {
  x?: number;
  y?: number;
  noBox?: true;
  intercepted?: { nodeName: string; attributes: string[] };
}

/** Resolve a backendNodeId to a live objectId and its click point. Throws
 *  a plain Error when the node is gone or has no box (caller heals). */
async function locate(
  tabId: number,
  backendNodeId: number,
  hitTest: boolean
): Promise<{ objectId: string; x: number; y: number; intercepted?: LocateResult["intercepted"] }> {
  const resolved = await send<{ object: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error(`node ${backendNodeId} did not resolve`);
  const resp = await send<{ result: { value?: LocateResult }; exceptionDetails?: unknown }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: LOCATE_FN,
    arguments: [{ value: hitTest }],
    returnByValue: true
  });
  const v = resp.result?.value;
  if (resp.exceptionDetails || !v || v.noBox || typeof v.x !== "number" || typeof v.y !== "number") {
    throw new Error(`node ${backendNodeId} has no box`);
  }
  return { objectId, x: v.x, y: v.y, intercepted: v.intercepted };
}

// Refuse to click through an unrelated element (overlay, sticky header,
// modal): the spec's Change 2 step 3, mirroring agent-browser's
// check_node_interception. The target, its descendants (inner span/text)
// and its ancestors (label wrapping an input) all count as the target.
function interceptedError(
  tool: ToolName,
  ref: string,
  x: number,
  y: number,
  interceptor: { nodeName: string; attributes: string[] }
): RelayError {
  return new RelayError({
    code: "click_intercepted",
    message: `${tool}: @${ref} resolved, but an unrelated <${interceptor.nodeName.toLowerCase()}> owns the click point (${x}, ${y}) — an overlay, sticky header, or modal is covering it. Dismiss it or scroll, then retry.`,
    tool,
    phase: "hit_test",
    details: { ref, x, y, interceptor },
    retryable: true
  });
}

/** Full resolution: ref → live backendNodeId + click center, healing if
 *  needed. `hitTest` (default true) gates the interception check — pointer
 *  actions (click, hover) want it; fill/type write through objectId/focus
 *  and work fine on a visually covered element, so they pass false. */
export async function resolveRefCenter(
  tool: ToolName,
  ref: string,
  target: TargetArgs,
  opts: { hitTest?: boolean } = {}
): Promise<ResolvedRef & { x: number; y: number; objectId: string }> {
  const hitTest = opts.hitTest !== false;
  const entry = await resolveRefTarget(tool, ref, target);
  const tabId = entry.tabId;

  // Fast path — locating the cached id verifies it is still live.
  try {
    const l = await locate(tabId, entry.backendNodeId, hitTest);
    if (l.intercepted) throw interceptedError(tool, ref, l.x, l.y, l.intercepted);
    return { tabId, backendNodeId: entry.backendNodeId, entry, healed: false, x: l.x, y: l.y, objectId: l.objectId };
  } catch (e) {
    if (e instanceof RelayError) throw e; // interception is a verdict, not staleness
    // fall through to heal
  }

  const fresh = await findBackendNodeByRoleName(tabId, entry.role, entry.name, entry.nth ?? 0);
  if (fresh === null) {
    throw staleRef(tool, ref, "no longer resolves (node gone, and no same-role/name replacement found)");
  }
  try {
    const l = await locate(tabId, fresh, hitTest);
    if (l.intercepted) throw interceptedError(tool, ref, l.x, l.y, l.intercepted);
    await healRefEntry(ref, fresh);
    return { tabId, backendNodeId: fresh, entry: { ...entry, backendNodeId: fresh }, healed: true, x: l.x, y: l.y, objectId: l.objectId };
  } catch (e) {
    if (e instanceof RelayError) throw e;
    throw staleRef(tool, ref, "resolved to a replacement node with no box (hidden or detached)");
  }
}

/** Resolve a ref to a Runtime objectId for in-page operations (fill). */
export async function resolveRefObjectId(
  tool: ToolName,
  ref: string,
  target: TargetArgs
): Promise<{ tabId: number; objectId: string; healed: boolean; x: number; y: number }> {
  const resolved = await resolveRefCenter(tool, ref, target, { hitTest: false }); // verify+heal, no pointer check
  return { tabId: resolved.tabId, objectId: resolved.objectId, healed: resolved.healed, x: resolved.x, y: resolved.y };
}

// ---------------------------------------------------------------------------
// Change 8 — error hygiene at the in-page boundary.
//
// The in-page functions (locateForClick, fillElement, focusSelector) throw
// plain Errors with messages we own; evalExpression re-throws them as plain
// Errors, which used to surface as internal_error with a raw JS stack.
// This maps our own known messages to closed-set codes in ONE place.

const PAGE_ERROR_PATTERNS: { pattern: RegExp; code: "element_not_found" | "invalid_arguments" }[] = [
  { pattern: /^Error: Element not found for selector/, code: "element_not_found" },
  { pattern: /^Error: Element has zero size/, code: "element_not_found" },
  { pattern: /^Error: Element could not be focused/, code: "element_not_found" },
  { pattern: /^Error: Fill target is not an input/, code: "invalid_arguments" },
  // querySelector with malformed CSS — the browser's own message.
  { pattern: /is not a valid selector/, code: "invalid_arguments" }
];

export function mapPageError(err: unknown, tool: ToolName, phase: string): never {
  if (err instanceof RelayError) throw err;
  const raw = err instanceof Error ? err.message : String(err);
  // evalExpression surfaces the page-side description, which starts with
  // "Error: <our message>" followed by a stack. Strip the stack.
  const firstLine = raw.split("\n")[0];
  for (const { pattern, code } of PAGE_ERROR_PATTERNS) {
    if (pattern.test(firstLine) || pattern.test(`Error: ${firstLine}`)) {
      throw new RelayError({
        code,
        message: firstLine.replace(/^Error:\s*/, ""),
        tool,
        phase,
        retryable: false
      });
    }
  }
  throw new RelayError({
    code: "internal_error",
    message: firstLine,
    tool,
    phase,
    details: { raw: raw.slice(0, 1000) },
    retryable: false
  });
}
