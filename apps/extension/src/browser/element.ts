// Ref → element resolution for actions (adoption-spec Change 2).
//
// Resolution path per action:
//   1. Fast path: cached backendNodeId → scrollIntoViewIfNeeded →
//      DOM.getBoxModel → center. The box-model fetch IS the staleness
//      verification — never skipped.
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

interface BoxModel { content: number[] }

async function boxCenter(tabId: number, backendNodeId: number): Promise<{ x: number; y: number }> {
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Not available on every target version — proceed; getBoxModel decides.
  }
  const resp = await send<{ model: BoxModel }>(tabId, "DOM.getBoxModel", { backendNodeId });
  const q = resp.model.content;
  return {
    x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4),
    y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4)
  };
}

// Hit-test the resolved click point and refuse to click through an
// unrelated element (overlay, sticky header, modal). The spec's Change 2
// step 3, mirroring agent-browser's check_node_interception. Rules:
//   - the hit node being the target, a descendant of it (inner span/text),
//    or an ancestor of it (label wrapping an input) is fine;
//   - anything else throws click_intercepted with the interceptor named.
// Best effort: if the hit-test itself fails (iframe boundaries, old CDP),
// we proceed rather than block — a skipped check beats a false positive.
async function assertNotIntercepted(
  tool: ToolName,
  ref: string,
  tabId: number,
  backendNodeId: number,
  x: number,
  y: number
): Promise<void> {
  let hitBackendNodeId: number;
  try {
    const hit = await send<{ backendNodeId: number }>(tabId, "DOM.getNodeForLocation", {
      x,
      y,
      includeUserAgentShadowDOM: false
    });
    hitBackendNodeId = hit.backendNodeId;
  } catch {
    return; // hit-test unavailable — proceed
  }
  if (hitBackendNodeId === backendNodeId) return;

  try {
    const a = await send<{ object: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
    const b = await send<{ object: { objectId?: string } }>(tabId, "DOM.resolveNode", {
      backendNodeId: hitBackendNodeId
    });
    if (!a.object?.objectId || !b.object?.objectId) return;
    const rel = await send<{ result: { value?: boolean } }>(tabId, "Runtime.callFunctionOn", {
      objectId: a.object.objectId,
      functionDeclaration:
        "function (other) { return this === other || this.contains(other) || other.contains(this); }",
      arguments: [{ objectId: b.object.objectId }],
      returnByValue: true
    });
    if (rel.result?.value === true) return; // same lineage — fine
  } catch {
    return; // relationship check failed — proceed, best effort
  }

  // Name the interceptor so the agent can act on it (dismiss the modal,
  // scroll past the sticky header) instead of guessing.
  let interceptor: Record<string, unknown> = { backendNodeId: hitBackendNodeId };
  try {
    const desc = await send<{ node: { nodeName: string; attributes?: string[] } }>(
      tabId,
      "DOM.describeNode",
      { backendNodeId: hitBackendNodeId }
    );
    interceptor = {
      backendNodeId: hitBackendNodeId,
      nodeName: desc.node.nodeName,
      attributes: desc.node.attributes?.slice(0, 12)
    };
  } catch {
    /* description is optional */
  }
  throw new RelayError({
    code: "click_intercepted",
    message: `${tool}: @${ref} resolved, but an unrelated <${String(interceptor.nodeName ?? "?").toLowerCase()}> owns the click point (${x}, ${y}) — an overlay, sticky header, or modal is covering it. Dismiss it or scroll, then retry.`,
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
): Promise<ResolvedRef & { x: number; y: number }> {
  const hitTest = opts.hitTest !== false;
  const entry = await resolveRefTarget(tool, ref, target);
  const tabId = entry.tabId;

  // Fast path — the box fetch verifies the cached id is still live.
  try {
    const { x, y } = await boxCenter(tabId, entry.backendNodeId);
    if (hitTest) await assertNotIntercepted(tool, ref, tabId, entry.backendNodeId, x, y);
    return { tabId, backendNodeId: entry.backendNodeId, entry, healed: false, x, y };
  } catch (e) {
    if (e instanceof RelayError) throw e; // interception is a verdict, not staleness
    // fall through to heal
  }

  const fresh = await findBackendNodeByRoleName(tabId, entry.role, entry.name, entry.nth ?? 0);
  if (fresh === null) {
    throw staleRef(tool, ref, "no longer resolves (node gone, and no same-role/name replacement found)");
  }
  try {
    const { x, y } = await boxCenter(tabId, fresh);
    if (hitTest) await assertNotIntercepted(tool, ref, tabId, fresh, x, y);
    await healRefEntry(ref, fresh);
    return { tabId, backendNodeId: fresh, entry: { ...entry, backendNodeId: fresh }, healed: true, x, y };
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
): Promise<{ tabId: number; objectId: string; healed: boolean }> {
  const resolved = await resolveRefCenter(tool, ref, target, { hitTest: false }); // verify+heal, no pointer check
  const resp = await send<{ object: { objectId?: string } }>(resolved.tabId, "DOM.resolveNode", {
    backendNodeId: resolved.backendNodeId
  });
  if (!resp.object?.objectId) {
    throw staleRef(tool, ref, "could not be resolved to a live JS object");
  }
  return { tabId: resolved.tabId, objectId: resp.object.objectId, healed: resolved.healed };
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
