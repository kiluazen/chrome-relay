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
  /** Present only when the caller asked for a diff: the previous snapshot's
   *  rendered text for this tab (null when there is none). The CLI diffs;
   *  the wire carries both, stdout carries only the changes. */
  prevText?: string | null;
}

// ---------------------------------------------------------------------------
// @ref token grammar. The @ prefix is mandatory in CLI positionals so a ref
// can never be confused with a CSS type selector (`e3` is a valid one).
//
// v2 (multi-profile): refs are PROFILE-QUALIFIED in the printable token —
// `@3f2a:e12` — because every profile mints its own e-counter from e1, so
// cross-profile collisions are the normal case, not an edge case. The prefix
// is the first 4 hex chars of the minting extension's instanceId; the CLI
// routes on it BEFORE contacting any extension. Refs are qualified ALWAYS,
// even with one profile connected: a token whose format depends on how many
// profiles happen to be running would be hidden state. Bare `@e12` stays
// accepted and follows the same routing rule as any unscoped command.

const REF_TOKEN = /^@((?:[0-9a-f]{4,32}:)?e\d+)$/;
const REF_ID = /^(?:([0-9a-f]{4,32}):)?(e\d+)$/;

/** "@e3" → "e3"; "@3f2a:e3" → "3f2a:e3"; anything else → null.
 *  Returns the full (possibly qualified) ref id — the wire form. */
export function parseRefToken(input: string): string | null {
  const m = REF_TOKEN.exec(input.trim());
  return m ? m[1] : null;
}

/** "e3" | "3f2a:e3" → "@e3" | "@3f2a:e3" (display form). */
export function formatRefToken(ref: string): string {
  return `@${ref}`;
}

/** Split a wire ref id into its instance prefix (null when bare) and local
 *  id. "3f2a:e12" → {prefix:"3f2a", id:"e12"}; "e12" → {prefix:null, id:"e12"};
 *  anything else → null. */
export function splitRefId(ref: string): { prefix: string | null; id: string } | null {
  const m = REF_ID.exec(ref.trim());
  return m ? { prefix: m[1] ?? null, id: m[2] } : null;
}

/** "e12" + "3f2a" → "3f2a:e12" (wire form). */
export function qualifyRefId(id: string, prefix: string): string {
  return `${prefix}:${id}`;
}

/** Derive the 4-hex-char ref/routing prefix from a UUID instanceId.
 *  Shared by the extension (mint) and the CLI (routing/display) so the two
 *  can never disagree on the derivation. */
export function instancePrefix(instanceId: string): string {
  return instanceId.replace(/-/g, "").toLowerCase().slice(0, 4);
}

/** Keys whose string values are ref ids on the wire. Only these are scanned
 *  for routing prefixes — scanning every string would false-positive on user
 *  data (a fill value that happens to look like "abcd:e5"). */
const REF_BEARING_KEYS = new Set(["ref", "clickRef"]);

/** Recursively collect the distinct instance prefixes carried by qualified
 *  refs in a tool-args object (recursion covers nested chrome_batch calls).
 *  Only values under ref-bearing keys are considered. The CLI routes on
 *  these before any extension is contacted; two different prefixes in one
 *  call is a target_conflict. */
export function collectRefPrefixes(args: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(args)) {
    for (const v of args) collectRefPrefixes(v, out);
    return out;
  }
  if (args && typeof args === "object") {
    for (const [key, v] of Object.entries(args)) {
      if (REF_BEARING_KEYS.has(key) && typeof v === "string") {
        const split = REF_ID.exec(v.trim());
        if (split?.[1]) out.add(split[1]);
      } else if (v && typeof v === "object") {
        collectRefPrefixes(v, out);
      }
    }
  }
  return out;
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
