// Unified page snapshot (adoption-spec Change 1).
//
// One tree, one ref space: CDP accessibility tree (semantic, cheap) merged
// with the cursor-interactive sweep (div-soup clickables the AX tree
// misses). Replaces both readPageSnapshot (DOM walk + CSS selector paths)
// and getAxTree (separate id space).
//
// The extension builds the tree and assigns refs — the ref map must live
// here (see refs.ts). The CLI renders the text via the protocol renderer.
// Wire bytes don't cost tokens; only stdout does.
//
// Frames: top-frame only (+ same-process iframes as exposed by the tab's
// AX tree). Our CDP helper routes by tabId alone, so OOPIFs are out of
// scope until session routing lands — declared in the spec.

import type {
  ChromeSnapshotArgs,
  SnapshotAttrs,
  SnapshotData,
  SnapshotNode,
  SnapshotRefEntry
} from "@chrome-relay/protocol";
import { RelayError, renderSnapshot, qualifyRefId, TOOL_NAMES } from "@chrome-relay/protocol";
import { evalInTab, send } from "./cdp";
import { markCursorInteractive, unmarkCursorInteractive } from "./page-actions";
import { assignRef as registerRef, beginTabSnapshot } from "./refs";
import { getRefPrefix } from "./identity";

// Interactive AX roles — always ref-bearing, even unnamed. Same 17-role set
// the old chrome_ax used.
export const INTERACTIVE_ROLES = new Set<string>([
  "button", "link", "checkbox", "radio", "textbox", "combobox", "listbox",
  "option", "menuitem", "menuitemcheckbox", "menuitemradio", "slider",
  "spinbutton", "switch", "tab", "treeitem", "searchbox"
]);

// Content roles — ref-bearing only when named (a named heading is a useful
// anchor; an anonymous one is noise).
const CONTENT_REF_ROLES = new Set<string>([
  "heading", "cell", "gridcell", "columnheader", "rowheader", "listitem",
  "img", "dialog", "alertdialog", "article"
]);

// Dropped outright — render noise.
const DROP_ROLES = new Set<string>(["InlineTextBox", "LineBreak", "ScrollBar"]);

// Cap on cursor-interactive sweep extras per snapshot.
const SWEEP_MAX = 100;

// Pattern elision (Shortcut's formula-aliasing idea, applied to trees):
// virtualized tables emit hundreds of consecutive siblings with identical
// SHAPE (same role, same attrs, same child structure — different text).
// Keep the first ELIDE_KEEP, replace the rest with one loud marker line.
// Thresholds are generous on purpose: never elide runs ≤ ELIDE_RUN_MIN, so
// ordinary lists (HN's ~30 alternating story rows don't even form a run)
// stay complete. Opt out entirely with --no-elide.
const ELIDE_RUN_MIN = 20;
const ELIDE_KEEP = 10;

// ---------------------------------------------------------------------------
// Raw CDP shapes (only the bits we read)

interface RawAXProperty {
  name: string;
  value: { type: string; value?: unknown };
}
interface RawAXNode {
  nodeId: string;
  ignored: boolean;
  role?: { type: string; value?: string };
  name?: { type: string; value?: string };
  value?: { type: string; value?: unknown };
  properties?: RawAXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface RawDomNode {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: RawDomNode[];
  shadowRoots?: RawDomNode[];
  contentDocument?: RawDomNode;
}

// Internal tree node — SnapshotNode plus the backendNodeId we need for ref
// assignment (stripped from the wire shape).
interface BuildNode {
  role: string;
  name?: string;
  value?: string;
  attrs?: SnapshotAttrs;
  backendNodeId?: number;
  source?: "sweep";
  children: BuildNode[];
  refEligible: boolean;
  ref?: string;
}

// ---------------------------------------------------------------------------
// AX → BuildNode tree

const TRISTATE = (v: unknown): boolean | "mixed" | undefined => {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  if (v === "mixed") return "mixed";
  return undefined;
};

function readAttrs(props: RawAXProperty[] | undefined, includeUrl: boolean): SnapshotAttrs | undefined {
  if (!props || props.length === 0) return undefined;
  const attrs: SnapshotAttrs = {};
  for (const p of props) {
    const v = p.value?.value;
    switch (p.name) {
      case "level":    if (typeof v === "number") attrs.level = v; break;
      case "checked": { const t = TRISTATE(v); if (t !== undefined) attrs.checked = t; break; }
      case "pressed": { const t = TRISTATE(v); if (t !== undefined) attrs.pressed = t; break; }
      case "expanded": if (typeof v === "boolean") attrs.expanded = v; break;
      case "selected": if (v === true) attrs.selected = true; break;
      case "disabled": if (v === true) attrs.disabled = true; break;
      case "required": if (v === true) attrs.required = true; break;
      case "readonly": if (v === true) attrs.readonly = true; break;
      case "url":      if (includeUrl && typeof v === "string" && v.length > 0) attrs.url = v.slice(0, 300); break;
    }
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function normalizeRole(role: string): string {
  if (role === "StaticText") return "text";
  // Chromium internal layout roles → their semantic table names.
  if (role === "LayoutTable") return "table";
  if (role === "LayoutTableRow") return "row";
  if (role === "LayoutTableCell") return "cell";
  return role;
}

function isRefEligible(role: string, name: string | undefined): boolean {
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (name && CONTENT_REF_ROLES.has(role)) return true;
  return false;
}

// A node earns its own output line if it's ref-eligible, carries a name,
// value, or attrs. Anything else is structure — its children promote up.
// This is the aggressive-collapse rule that makes the default output
// compact (agent-browser's -c behavior, on by default here).
function earnsLine(n: BuildNode): boolean {
  return n.refEligible || !!n.name || n.value !== undefined || !!n.attrs;
}

function buildAxTree(raw: RawAXNode[], includeUrls: boolean): BuildNode[] {
  const byId = new Map<string, RawAXNode>();
  for (const r of raw) byId.set(r.nodeId, r);

  function walk(axId: string, parentName: string | undefined): BuildNode[] {
    const node = byId.get(axId);
    if (!node) return [];
    const roleRaw = node.role?.value ?? "";
    const name = typeof node.name?.value === "string" && node.name.value.length > 0
      ? node.name.value.slice(0, 200)
      : undefined;

    if (node.ignored || !roleRaw || DROP_ROLES.has(roleRaw)) {
      return (node.childIds ?? []).flatMap((c) => walk(c, parentName));
    }

    const role = normalizeRole(roleRaw);

    // Text node that just repeats its parent's name — pure duplication.
    if (role === "text" && name !== undefined && name === parentName) return [];
    if (role === "text" && name === undefined) return [];

    const children = (node.childIds ?? []).flatMap((c) => walk(c, name ?? parentName));

    const valueRaw = node.value?.value;
    const built: BuildNode = {
      role,
      name,
      value: valueRaw !== undefined && valueRaw !== null && valueRaw !== "" ? String(valueRaw).slice(0, 200) : undefined,
      attrs: readAttrs(node.properties, includeUrls),
      backendNodeId: typeof node.backendDOMNodeId === "number" ? node.backendDOMNodeId : undefined,
      children,
      refEligible: isRefEligible(role, name)
    };

    if (!earnsLine(built)) return children; // collapse: promote children
    return [built];
  }

  const childIds = new Set<string>();
  for (const r of raw) for (const c of r.childIds ?? []) childIds.add(c);
  const roots = raw.filter((r) => !childIds.has(r.nodeId)).map((r) => r.nodeId);
  return roots.flatMap((id) => walk(id, undefined));
}

// ---------------------------------------------------------------------------
// Cursor-interactive sweep — backendNodeId resolution via one DOM.getDocument

// Collect sweep-tagged backendNodeIds. When `scopeBackendId` is set, only
// nodes inside that subtree count — `snapshot -s "#modal"` must not hand
// out actionable refs for cursor-pointer elements elsewhere on the page.
function collectSweepBackendIds(
  root: RawDomNode,
  out: Map<number, number>,
  scopeBackendId: number | undefined,
  inScope: boolean
): void {
  const nowInScope = inScope || scopeBackendId === undefined || root.backendNodeId === scopeBackendId;
  const attrs = root.attributes;
  if (nowInScope && attrs) {
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i] === "data-cr-sweep") {
        const idx = Number(attrs[i + 1]);
        if (Number.isFinite(idx)) out.set(idx, root.backendNodeId);
      }
    }
  }
  for (const c of root.children ?? []) collectSweepBackendIds(c, out, scopeBackendId, nowInScope);
  for (const s of root.shadowRoots ?? []) collectSweepBackendIds(s, out, scopeBackendId, nowInScope);
  if (root.contentDocument) collectSweepBackendIds(root.contentDocument, out, scopeBackendId, nowInScope);
}

async function runSweep(
  tabId: number,
  scopeBackendId?: number
): Promise<{ backendNodeId: number; tag: string; text: string }[]> {
  const items = await evalInTab(tabId, markCursorInteractive, [SWEEP_MAX]);
  try {
    if (!items || items.length === 0) return [];
    const doc = await send<{ root: RawDomNode }>(tabId, "DOM.getDocument", { depth: -1, pierce: true });
    const byIdx = new Map<number, number>();
    collectSweepBackendIds(doc.root, byIdx, scopeBackendId, false);
    const out: { backendNodeId: number; tag: string; text: string }[] = [];
    for (const item of items) {
      const backendNodeId = byIdx.get(item.i);
      if (backendNodeId !== undefined) out.push({ backendNodeId, tag: item.tag, text: item.text });
    }
    return out;
  } finally {
    await evalInTab(tabId, unmarkCursorInteractive, []).catch(() => {
      /* cleanup is best-effort; attribute leaks are inert */
    });
  }
}

// ---------------------------------------------------------------------------
// Scope / depth / interactive filters

function findScopeSubtree(nodes: BuildNode[], backendNodeId: number): BuildNode | null {
  for (const n of nodes) {
    if (n.backendNodeId === backendNodeId) return n;
    const found = findScopeSubtree(n.children, backendNodeId);
    if (found) return found;
  }
  return null;
}

function pruneToRefBearing(nodes: BuildNode[]): BuildNode[] {
  return nodes.flatMap((n) => {
    const children = pruneToRefBearing(n.children);
    if (n.refEligible || n.source === "sweep") {
      return [{ ...n, children }];
    }
    return children;
  });
}

function truncateDepth(nodes: BuildNode[], depth: number): BuildNode[] {
  if (depth <= 0) return [];
  return nodes.map((n) => ({ ...n, children: truncateDepth(n.children, depth - 1) }));
}

// Shape signature: identical role + named-ness + attr keys + child roles.
// Text content deliberately excluded — that's what VARIES across rows.
function shapeSig(n: BuildNode): string {
  return [
    n.role,
    n.name ? "named" : "anon",
    Object.keys(n.attrs ?? {}).sort().join("+"),
    n.children.map((c) => c.role).join(",")
  ].join("|");
}

function elideRepeats(nodes: BuildNode[]): BuildNode[] {
  const out: BuildNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const sig = shapeSig(nodes[i]);
    let j = i + 1;
    while (j < nodes.length && shapeSig(nodes[j]) === sig) j++;
    const runLen = j - i;
    if (runLen > ELIDE_RUN_MIN) {
      for (let k = i; k < i + ELIDE_KEEP; k++) {
        out.push({ ...nodes[k], children: elideRepeats(nodes[k].children) });
      }
      out.push({
        role: "elided",
        name: `${runLen - ELIDE_KEEP} more ${nodes[i].role} siblings with the same shape — scope with -s <css>, or pass --no-elide for all`,
        children: [],
        refEligible: false
      });
    } else {
      for (let k = i; k < j; k++) {
        out.push({ ...nodes[k], children: elideRepeats(nodes[k].children) });
      }
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ref assignment + wire conversion

function assignRefs(
  nodes: BuildNode[],
  tabId: number,
  nthCounter: Map<string, number>,
  refs: Record<string, SnapshotRefEntry>,
  prior: Map<number, string>,
  refPrefix: string
): void {
  for (const n of nodes) {
    if ((n.refEligible || n.source === "sweep") && n.backendNodeId !== undefined) {
      const key = `${n.role}|${n.name ?? ""}`;
      const nth = nthCounter.get(key) ?? 0;
      nthCounter.set(key, nth + 1);
      const entry: SnapshotRefEntry = {
        tabId,
        backendNodeId: n.backendNodeId,
        role: n.role,
        name: n.name ?? "",
        ...(nth > 0 ? { nth } : {})
      };
      // Internal RefMap keys stay bare (`eN`); the WIRE form is profile-
      // qualified (`3f2a:e12`) so the printed token routes across profiles.
      // Qualification always happens, even single-profile — a token whose
      // format depends on connected-profile count would be hidden state.
      const ref = registerRef(entry, prior);
      const wireRef = qualifyRefId(ref, refPrefix);
      n.ref = wireRef;
      refs[wireRef] = entry;
    }
    assignRefs(n.children, tabId, nthCounter, refs, prior, refPrefix);
  }
}

function toWire(nodes: BuildNode[]): SnapshotNode[] {
  return nodes.map((n) => {
    const out: SnapshotNode = { role: n.role };
    if (n.name) out.name = n.name;
    if (n.value !== undefined) out.value = n.value;
    if (n.ref) out.ref = n.ref;
    if (n.attrs) out.attrs = n.attrs;
    if (n.source) out.source = n.source;
    const children = toWire(n.children);
    if (children.length > 0) out.children = children;
    return out;
  });
}

function countNodes(nodes: SnapshotNode[]): number {
  let c = 0;
  const walk = (ns: SnapshotNode[]) => { for (const n of ns) { c++; if (n.children) walk(n.children); } };
  walk(nodes);
  return c;
}

// ---------------------------------------------------------------------------
// Public builder

// Previous rendered snapshot per tab — feeds `snapshot --diff` (Change 4).
// In-memory only: an SW restart loses it and the next --diff prints full,
// which is the safe degradation. Dropped on tab close.
const lastSnapshotText = new Map<number, string>();
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => lastSnapshotText.delete(tabId));
}

export async function buildSnapshot(
  tabId: number,
  opts: Pick<ChromeSnapshotArgs, "interactiveOnly" | "depth" | "scope" | "urls" | "diff" | "elide">
): Promise<SnapshotData> {
  await send(tabId, "Accessibility.enable", {});
  const response = await send<{ nodes: RawAXNode[] }>(tabId, "Accessibility.getFullAXTree", { depth: -1 });

  let tree = buildAxTree(response.nodes ?? [], opts.urls === true);

  // --scope <css>: resolve the scope element FIRST so both the AX subtree
  // filter AND the sweep are bounded by it — a scoped snapshot must never
  // hand out actionable refs for elements outside the scope.
  let scopeBackendId: number | undefined;
  if (opts.scope) {
    const doc = await send<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", { depth: 0 });
    const match = await send<{ nodeId: number }>(tabId, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: opts.scope
    });
    if (!match.nodeId) {
      throw new RelayError({
        code: "element_not_found",
        message: `chrome_snapshot: no element matches scope selector ${opts.scope}`,
        tool: TOOL_NAMES.SNAPSHOT,
        phase: "resolve_scope",
        details: { scope: opts.scope },
        retryable: false
      });
    }
    const described = await send<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", {
      nodeId: match.nodeId
    });
    scopeBackendId = described.node.backendNodeId;
    const subtree = findScopeSubtree(tree, scopeBackendId);
    tree = subtree ? [subtree] : [];
  }

  const sweepItems = await runSweep(tabId, scopeBackendId);

  if (opts.interactiveOnly) tree = pruneToRefBearing(tree);
  if (opts.depth !== undefined) tree = truncateDepth(tree, opts.depth);
  // Elide BEFORE ref assignment — elided rows never consume refs, so the
  // ref map matches what's printed. The marker line is loud, not silent.
  if (opts.elide !== false) tree = elideRepeats(tree);

  // Refs: stable across re-snapshots. Elements that survived keep their
  // @eN (reused via the prior map); new elements get fresh global ids;
  // vanished elements' refs die because they're never re-registered.
  const prior = await beginTabSnapshot(tabId);
  const refPrefix = await getRefPrefix();
  const refs: Record<string, SnapshotRefEntry> = {};
  const nthCounter = new Map<string, number>();
  assignRefs(tree, tabId, nthCounter, refs, prior, refPrefix);

  // Sweep extras — div-soup clickables the AX tree missed. Dedupe against
  // backendNodeIds that already got a ref above.
  const seenBackendIds = new Set<number>(Object.values(refs).map((r) => r.backendNodeId));
  const sweepNodes: BuildNode[] = [];
  for (const item of sweepItems) {
    if (seenBackendIds.has(item.backendNodeId)) continue;
    sweepNodes.push({
      role: "clickable",
      name: item.text || item.tag,
      backendNodeId: item.backendNodeId,
      source: "sweep",
      children: [],
      refEligible: true
    });
  }
  assignRefs(sweepNodes, tabId, nthCounter, refs, prior, refPrefix);
  tree = tree.concat(sweepNodes);

  let title = "";
  let url = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab.title ?? "";
    url = tab.url ?? "";
  } catch { /* non-fatal */ }

  const nodes = toWire(tree);
  const data: SnapshotData = { title, url, tabId, nodeCount: countNodes(nodes), nodes, refs };

  // Always record the rendered text (so the FIRST --diff after plain
  // snapshots has a baseline); only ship prevText over the wire when the
  // caller asked to diff. A full snapshot is still taken and the ref map
  // still refreshed — diff changes what is printed, never what happened.
  const text = renderSnapshot(data);
  const prevText = lastSnapshotText.get(tabId);
  lastSnapshotText.set(tabId, text);
  if (opts.diff) data.prevText = prevText ?? null;

  return data;
}

// ---------------------------------------------------------------------------
// Heal support (adoption-spec Change 2, stale path). Re-query the AX tree
// and find the nth node matching role+name. Used by the ref resolver when a
// cached backendNodeId no longer has a box. Sweep refs (role "clickable")
// have no AX presence and can't heal this way — they go straight to
// stale_ref, documented behavior.

export async function findBackendNodeByRoleName(
  tabId: number,
  role: string,
  name: string,
  nth: number
): Promise<number | null> {
  if (role === "clickable") return null;
  await send(tabId, "Accessibility.enable", {});
  const response = await send<{ nodes: RawAXNode[] }>(tabId, "Accessibility.getFullAXTree", { depth: -1 });
  let seen = 0;
  for (const raw of response.nodes ?? []) {
    if (raw.ignored) continue;
    const r = normalizeRole(raw.role?.value ?? "");
    if (r !== role) continue;
    const n = typeof raw.name?.value === "string" ? raw.name.value.slice(0, 200) : "";
    if (n !== name) continue;
    if (seen === nth) {
      return typeof raw.backendDOMNodeId === "number" ? raw.backendDOMNodeId : null;
    }
    seen += 1;
  }
  return null;
}
