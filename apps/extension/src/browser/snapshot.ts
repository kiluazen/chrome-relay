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
import { RelayError, TOOL_NAMES } from "@chrome-relay/protocol";
import { evalInTab, send } from "./cdp";
import { markCursorInteractive, unmarkCursorInteractive } from "./page-actions";
import { allocateRef, invalidateTabRefs } from "./refs";

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

// ---------------------------------------------------------------------------
// Ref assignment + wire conversion

function assignRefs(
  nodes: BuildNode[],
  tabId: number,
  nthCounter: Map<string, number>,
  refs: Record<string, SnapshotRefEntry>
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
      const ref = allocateRef(entry);
      n.ref = ref;
      refs[ref] = entry;
    }
    assignRefs(n.children, tabId, nthCounter, refs);
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

export async function buildSnapshot(
  tabId: number,
  opts: Pick<ChromeSnapshotArgs, "interactiveOnly" | "depth" | "scope" | "urls">
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

  // Refs: snapshot-scoped — drop this tab's old refs, then assign fresh ids
  // in document order. The global counter makes them browser-unique.
  await invalidateTabRefs(tabId);
  const refs: Record<string, SnapshotRefEntry> = {};
  const nthCounter = new Map<string, number>();
  assignRefs(tree, tabId, nthCounter, refs);

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
  assignRefs(sweepNodes, tabId, nthCounter, refs);
  tree = tree.concat(sweepNodes);

  let title = "";
  let url = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab.title ?? "";
    url = tab.url ?? "";
  } catch { /* non-fatal */ }

  const nodes = toWire(tree);
  return { title, url, tabId, nodeCount: countNodes(nodes), nodes, refs };
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
