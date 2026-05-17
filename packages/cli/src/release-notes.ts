// Release notes — agent-readable changelog.
//
// Discipline: every release adds a new key here. Forcing function — release
// notes become part of the diff, not a separate CHANGELOG.md that goes stale.
//
// Read by `chrome-relay update` (post-install, with --since <old-version>) and
// by `chrome-relay release-notes --since <version>` (queryable without
// updating). Both slice the same map and return a structured payload the
// agent can consume.

export const RELEASE_NOTES: Record<string, string[]> = {
  "0.5.3": [
    "Structured errors and notices (code-quality-hardening PR 1). New `BridgeError` and `BridgeNotice` types in @chrome-relay/protocol carry a code, tool, phase, and details — agents can branch on `errorDetails.code === 'invalid_arguments'` instead of regex-matching message strings.",
    "Tool result JSON now carries BOTH the legacy fields (`error: string`, `notice: string`) AND the new structured fields (`errorDetails: BridgeError`, `notices: BridgeNotice[]`). Old consumers keep working; new consumers prefer the structured shape.",
    "The cli-outdated notice is now a `BridgeNotice` with `code:'cli_outdated'`, `details.currentVersion`, `details.expectedVersion`, and an `action.command` field.",
    "Every strict parser (PR 0 strict enums) now throws `RelayError` with `code:'invalid_arguments'`, the offending tool, the phase that failed, and the list of valid choices.",
    "All action-validator throws (chrome_console, chrome_network, chrome_viewport, chrome_workspace, chrome_group, chrome_screencast) carry the same structured shape.",
    "Unknown tool dispatch now returns `code:'unsupported_tool'`.",
    "CLI: when a RelayError flows back, stderr prints the human message AND a `relayError` JSON object so agents can parse the structured details from stderr without needing a separate flag."
  ],
  "0.5.2": [
    "Strict input parsers (code-quality-hardening PR 0). Invalid console levels, network status filters, tab-group colors, and tab-id lists now throw instead of being silently dropped — an agent that asks for `errors` (typo of `error`) gets a precise error rather than all levels back.",
    "Affected tools: chrome_console (levels), chrome_network (status), chrome_group (color, tabIds), chrome_screencast (format, action), chrome_network (action).",
    "Parsers moved to apps/extension/src/browser/parsers.ts (pure module, no chrome runtime imports) so they're directly unit-testable. 24 new tests cover the strict paths."
  ],
  "0.5.1": [
    "Tool results now carry a `notice` field when the CLI is older than the connected extension — agents (or humans) get a structured nudge to run `chrome-relay update`.",
    "New subcommand: `chrome-relay update` — installs the latest CLI via your package manager and prints what changed.",
    "New subcommand: `chrome-relay release-notes --since <version>` — query the same change log without updating."
  ],
  "0.5.0": [
    "New tool: `chrome_hover` — `Input.dispatchMouseEvent mouseMoved` at a selector or x,y. Fires :hover, :focus-within, tooltips, dropdown openers without clicking.",
    "New tool: `chrome_screencast` — paint-driven CDP recording. Catches CSS transitions, fade-ins, and animation mid-states that screenshot polling misses. Requires the tab to be active.",
    "`chrome-relay screencast {start,stop}` CLI with default-on SHA-256 dedupe (--no-dedupe to keep raw frames) and --gif/--mp4 ffmpeg post-step.",
    "JPEG default quality bumped 60 → 80 for max precision. See docs/recording.md."
  ],
  "0.4.0": [
    "BREAKING: `chrome_group` repurposed for Chrome's native tab-groups (the colored, collapsible folders). Old isolation-window semantics moved to `chrome_workspace`.",
    "New CLI: `chrome-relay workspace {create,list,close}` for parallel agent isolation (named background windows).",
    "New CLI: `chrome-relay group {create,list,close,add,remove}` for visual tab-grouping inside a single window."
  ]
};

// Tiny semver comparator. Only handles `MAJOR.MINOR.PATCH` (no pre-release
// tags) — that's all we publish. Returns -1, 0, 1.
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

export interface VersionChanges {
  version: string;
  bullets: string[];
}

// Slice RELEASE_NOTES to versions strictly greater than `since`, sorted
// ascending (oldest first — the order a human would read them).
export function listReleaseNotesSince(since: string): VersionChanges[] {
  return Object.keys(RELEASE_NOTES)
    .filter((v) => compareSemver(v, since) > 0)
    .sort((a, b) => compareSemver(a, b))
    .map((version) => ({ version, bullets: RELEASE_NOTES[version] }));
}
