// Snapshot wire types + the canonical text renderer (adoption-spec Change 1).
//
// The extension builds the tree (AX walk + cursor-interactive sweep) and
// assigns refs; the CLI renders the text. The renderer lives HERE — in the
// protocol package — so the printed format is a tested contract shared by
// the CLI and the golden-file tests, not an accident of string concatenation
// in either end. Wire bytes don't cost tokens; only stdout does.
//
// Format (agent-browser's proven scheme — don't innovate on it):
//
//   Page: Hacker News
//   URL: https://news.ycombinator.com/
//   Tab: 460154280
//
//   - link "Hacker News" [ref=e2]
//   - cell "1." [ref=e10]
//     - link "Lines of Code Got a Better Publicist" [ref=e11]
//   - textbox "Search" [ref=e41]: kushal@example.com
//   - checkbox "Remember me" [checked, ref=e42]
//
// Grammar per node: `- {role} {"name"?} [{attrs}]{: value?}`. The attrs
// bracket carries, in order: level=N, checked, expanded, selected, disabled,
// required, readonly, pressed, ref=eN, url=… . Boolean attrs render bare
// when true (`checked`), `=false` / `=mixed` otherwise — an unchecked
// checkbox still announces it HAS the state. Value renders as a `: text`
// suffix only when it differs from the name.

// One node in the unified snapshot tree. `ref` is present only on
// ref-bearing nodes (interactive roles, named content roles, cursor-
// interactive sweep extras).
export interface SnapshotNode {
  role: string;
  name?: string;
  value?: string;
  ref?: string; // "e12" — bare id, no @ prefix on the wire
  attrs?: SnapshotAttrs;
  /** "sweep" marks cursor-interactive elements the AX tree missed. */
  source?: "sweep";
  children?: SnapshotNode[];
}

export interface SnapshotAttrs {
  level?: number;
  checked?: boolean | "mixed";
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  readonly?: boolean;
  pressed?: boolean | "mixed";
  url?: string;
}

// What a ref resolves to. Lives in the extension's global RefMap; included
// in --json output so programmatic callers can target without re-parsing.
// `tabId` is what makes bare `@eN` tab-safe: the ref carries its tab.
export interface SnapshotRefEntry {
  tabId: number;
  backendNodeId: number;
  role: string;
  name: string;
  /** Disambiguator among same role+name on the page, 0-based document order. */
  nth?: number;
}

export interface SnapshotData {
  title: string;
  url: string;
  tabId: number;
  nodeCount: number;
  nodes: SnapshotNode[];
  refs: Record<string, SnapshotRefEntry>;
}

// ---------------------------------------------------------------------------
// @ref token grammar. The @ prefix is mandatory in CLI positionals so a ref
// can never be confused with a CSS type selector (`e3` is a valid one).

const REF_TOKEN = /^@(e\d+)$/;

/** "@e3" → "e3"; anything else → null. */
export function parseRefToken(input: string): string | null {
  const m = REF_TOKEN.exec(input.trim());
  return m ? m[1] : null;
}

/** "e3" → "@e3" (display form). */
export function formatRefToken(ref: string): string {
  return `@${ref}`;
}

// ---------------------------------------------------------------------------
// Renderer

const ATTR_ORDER: (keyof SnapshotAttrs)[] = [
  "level",
  "checked",
  "expanded",
  "selected",
  "disabled",
  "required",
  "readonly",
  "pressed",
  "url"
];

function renderAttrs(node: SnapshotNode): string {
  const parts: string[] = [];
  const attrs = node.attrs;
  if (attrs) {
    for (const key of ATTR_ORDER) {
      if (key === "url") continue; // url renders last, after ref
      const v = attrs[key];
      if (v === undefined) continue;
      if (v === true) parts.push(key);
      else parts.push(`${key}=${v}`);
    }
  }
  if (node.ref) parts.push(`ref=${node.ref}`);
  if (attrs?.url) parts.push(`url=${attrs.url}`);
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

function renderNode(node: SnapshotNode, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  let line = `${indent}- ${node.role}`;
  if (node.name) line += ` ${JSON.stringify(node.name)}`;
  line += renderAttrs(node);
  if (node.value !== undefined && node.value !== node.name) {
    line += `: ${node.value}`;
  }
  out.push(line);
  for (const child of node.children ?? []) {
    renderNode(child, depth + 1, out);
  }
}

export function renderSnapshot(data: SnapshotData): string {
  const nodes = data.nodes ?? [];
  const out: string[] = [`Page: ${data.title ?? ""}`, `URL: ${data.url ?? ""}`, `Tab: ${data.tabId ?? "?"}`, ""];
  for (const node of nodes) renderNode(node, 0, out);
  if (nodes.length === 0) out.push("(empty snapshot — page may still be loading)");
  return out.join("\n");
}
