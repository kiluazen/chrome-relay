// Accessibility tree extraction (§2.4 of boundaries.md).
//
// 30× smaller than the DOM snapshot for the same page, and far more
// semantic — what the LLM reads matches what a screen reader would
// announce. Click-targets are reachable via backendDOMNodeId so we
// don't depend on brittle CSS class hashes.
//
// Public exports:
//   getAxTree(tabId, opts)       → compact JSON tree
//   clickAxNode(tabId, nodeId)   → coordinate click on a node returned above
//
// The CLI surface (chrome_ax / chrome_click_ax tools) wraps these with arg
// parsing in tools.ts.

import { send } from "./cdp";

// The 17 roles that count as "actionable" — confirmed in the design doc.
// Everything else (heading, region, presentation, etc.) drops out under
// --interactive-only.
const INTERACTIVE_ROLES = new Set<string>([
  "button",
  "link",
  "checkbox",
  "radio",
  "textbox",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
  "searchbox"
]);

// Stateful AX properties that matter for interaction decisions.
const STATE_PROPS = new Set<string>([
  "focused",
  "disabled",
  "checked",
  "expanded",
  "pressed",
  "selected",
  "required",
  "readonly",
  "modal",
  "level",
  "valuemin",
  "valuemax",
  "valuenow"
]);

// Raw CDP types — only the bits we care about.
interface RawAXProperty {
  name: string;
  value: { type: string; value?: unknown };
}
interface RawAXNode {
  nodeId: string;             // AX-internal id, stable within ONE getFullAXTree call
  ignored: boolean;
  role?: { type: string; value?: string };
  name?: { type: string; value?: string };
  value?: { type: string; value?: unknown };
  description?: { type: string; value?: string };
  properties?: RawAXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface CompactAxNode {
  id: number;                  // backendDOMNodeId — the click target
  axId: string;                // AX-internal id (for cross-referencing if needed)
  role: string;
  name?: string;
  value?: string;
  description?: string;
  state?: Record<string, unknown>;
  children?: CompactAxNode[];
}

export interface AxTreeOptions {
  interactiveOnly?: boolean;
  rootRole?: string;            // start from the first node matching this role
  includeSubframes?: boolean;   // default: top-frame only
}

function readState(props: RawAXProperty[] | undefined): Record<string, unknown> | undefined {
  if (!props || props.length === 0) return undefined;
  const state: Record<string, unknown> = {};
  for (const p of props) {
    if (STATE_PROPS.has(p.name)) {
      const v = p.value?.value;
      if (v !== undefined && v !== null) state[p.name] = v;
    }
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

function compact(raw: RawAXNode): CompactAxNode | null {
  if (raw.ignored) return null;
  if (typeof raw.backendDOMNodeId !== "number") return null;
  const role = raw.role?.value;
  if (!role) return null;

  const node: CompactAxNode = {
    id: raw.backendDOMNodeId,
    axId: raw.nodeId,
    role
  };
  const name = raw.name?.value;
  if (typeof name === "string" && name.length > 0) {
    node.name = name.slice(0, 200);
  }
  const value = raw.value?.value;
  if (value !== undefined && value !== null) {
    node.value = String(value).slice(0, 200);
  }
  const desc = raw.description?.value;
  if (typeof desc === "string" && desc.length > 0) {
    node.description = desc.slice(0, 200);
  }
  const state = readState(raw.properties);
  if (state) node.state = state;
  return node;
}

// Build a tree from the flat list. CDP returns nodes in document order with
// parentId/childIds links; we rebuild the hierarchy ourselves so the JSON
// nests cleanly. Nodes that compact() returns null for (ignored, no role)
// are skipped but their children promote up to the grandparent — this is
// how the browser's a11y tree already does collapse for layout-only divs.
function buildTree(raw: RawAXNode[], opts: AxTreeOptions): CompactAxNode[] {
  const byAxId = new Map<string, RawAXNode>();
  for (const r of raw) byAxId.set(r.nodeId, r);

  function walk(axId: string): CompactAxNode[] {
    const node = byAxId.get(axId);
    if (!node) return [];
    const c = compact(node);
    const kids = (node.childIds ?? []).flatMap(walk);
    if (c) {
      // Apply --interactive-only here so we don't strip kids whose parent
      // is non-interactive (heading > link, for example).
      if (opts.interactiveOnly && !INTERACTIVE_ROLES.has(c.role)) {
        return kids;
      }
      if (kids.length > 0) c.children = kids;
      return [c];
    }
    return kids;
  }

  // Find roots — nodes with no parent in the result set.
  const childAxIds = new Set<string>();
  for (const r of raw) for (const c of r.childIds ?? []) childAxIds.add(c);
  const rootIds = raw.map((r) => r.nodeId).filter((id) => !childAxIds.has(id));

  let result = rootIds.flatMap(walk);

  // --root <role>: take the first matching subtree.
  if (opts.rootRole) {
    const found = findFirstByRole(result, opts.rootRole);
    if (found) result = [found];
  }

  return result;
}

function findFirstByRole(nodes: CompactAxNode[], role: string): CompactAxNode | null {
  for (const n of nodes) {
    if (n.role === role) return n;
    if (n.children) {
      const r = findFirstByRole(n.children, role);
      if (r) return r;
    }
  }
  return null;
}

export async function getAxTree(tabId: number, opts: AxTreeOptions = {}): Promise<{
  tree: CompactAxNode[];
  nodeCount: number;
  url: string | undefined;
  frameStrategy: "top" | "all";
}> {
  await send(tabId, "Accessibility.enable", {});

  // Top-frame only by default — the design call says opt-in for subframes.
  // (CDP's Accessibility.getFullAXTree without frameId returns top-frame only.)
  if (opts.includeSubframes) {
    // TODO: when needed, fetch the per-frame trees via Page.getFrameTree +
    // per-frame getFullAXTree, then merge. Not in this cut — covered by the
    // explicit (a) decision in the design doc.
  }

  const response = await send<{ nodes: RawAXNode[] }>(tabId, "Accessibility.getFullAXTree", { depth: -1 });

  const tree = buildTree(response.nodes ?? [], opts);

  // Count nodes after compact + filter for the response metadata.
  let count = 0;
  const countNodes = (ns: CompactAxNode[]) => { for (const n of ns) { count++; if (n.children) countNodes(n.children); } };
  countNodes(tree);

  // Try to get the page URL — cheap, lets the agent confirm "yep, captured the right tab."
  let url: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url;
  } catch { /* non-fatal */ }

  return {
    tree,
    nodeCount: count,
    url,
    frameStrategy: opts.includeSubframes ? "all" : "top"
  };
}

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
    throw new Error(
      `AX node ${backendDOMNodeId} no longer exists or has no box. Re-run \`chrome-relay ax\` and try again. ` +
        `(${e instanceof Error ? e.message : String(e)})`
    );
  }
  if (!boxModel) {
    throw new Error(`AX node ${backendDOMNodeId} returned no box model.`);
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
