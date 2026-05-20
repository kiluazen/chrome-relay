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
  "0.5.21": [
    "Fix: `chrome-relay update` and `chrome-relay install` now SIGTERM any running native-host.js process before exiting, and `update` re-runs `install` from the freshly-installed binary. Chrome respawns the host from the new manifest on its next native-messaging request.",
    "Why this matters: Chrome's native messaging keeps the host process alive for the session. Pre-0.5.21, `chrome-relay update` refreshed the on-disk package but Chrome kept routing through the OLD host. The HTTP bridge served by that old host then reported its own embedded `CHROME_RELAY_VERSION`, which falsely tripped the cli-outdated nudge against the newer extension. Users running the very command the nudge told them to run found the nudge still firing afterwards — the worst kind of UX bug.",
    "Best-effort and silent on failure: kill is only attempted on darwin/linux, only matches `native-host.js` paths that also contain `chrome-relay`, and ignores individual kill errors (already gone, no permission). Won't kill the running CLI itself."
  ],
  "0.5.20": [
    "BREAKING — `chrome-relay navigate` no longer steals focus by default. Background is now the implicit behavior; agents pass `--active` when they actually want the user looking at the new tab. The whole product pitch is 'operate without stealing focus' — the default needed to match.",
    "`--inactive` flag removed entirely. It was the opt-in for the previous (wrong) default; now it'd be a no-op, and no-op flags are dead code. Agents that were passing `--inactive` should drop it (the behavior is now the default). Commander will reject the unknown flag — that's the right signal to update.",
    "Workspace `chrome.windows.create({focused: false})` was already correct from earlier work, so workspaces are unaffected.",
    "Click now dispatches as a pointer event. Added `pointerType: \"mouse\"` to all three `Input.dispatchMouseEvent` calls in the CLICK handler. Without it, CDP only fires mouse events — modern UI libs (Radix, React-Aria, Headless UI) listen on `pointerdown` and silently ignore mouse-only clicks, so dropdowns / menu triggers / select widgets stayed closed even though the click registered. Discovered while dogfooding `chrome-relay click --x N --y N` against npm's token-creation form; verified by completing the full token-creation flow end-to-end (radio click, combobox open, submit) via chrome-relay tools.",
    "Tests: navigate test updated to assert no `active` field in default request, plus a new test verifying `--active` opts in to focus."
  ],
  "0.5.19": [
    "Coordinate click. `chrome-relay click --x N --y N --tab N` dispatches a trusted Input.dispatchMouseEvent at the given pixel coordinates — no selector required. The selector positional became optional; the protocol parser collapses click args into a discriminated union (`kind: 'selector'` | `kind: 'coords'`) and rejects partial coords (`--x` without `--y`) with `invalid_arguments`.",
    "Intentionally NOT shipping `click-text`. Once coord-click exists, finding text + clicking is fully composable with `js` (TreeWalker → getBoundingClientRect) → `click --x/--y`. Per the CLI philosophy, that's a smart wrapper, not a primitive. The two-step recipe lives in docs/clicking-strategies.md as the documented pattern.",
    "Updated docs: docs/clicking-strategies.md now lists the 4 click verbs (click selector/coords, click-ax, js) and the text-recipe; docs/cli-philosophy.md explains the hide-vs-expose calculus that led to this design.",
    "Tests: +2 in program.test.ts (coord-click + partial-coords rejection), +1 in args-all.test.ts (discriminated-union parsing). Existing click tests updated to expect the parsed `kind: 'selector'` shape now that CLI-side parseToolArgs runs before send."
  ],
  "0.5.18": [
    "Force-visible on attach — actually fixes Cloudflare-style SPAs now. 0.5.17 had two bugs: (1) missing `Page.enable` before `Page.addScriptToEvaluateOnNewDocument` (the script registration silently failed, so the shim only applied to the current doc — page reloads dropped it), (2) the JS shim used one try-block so a deprecated `Object.defineProperty(document, 'webkitVisibilityState')` could throw and skip the `document.hasFocus` patch.",
    "0.5.18 fixes both: enables Page domain first, then applies each patch in its own try/catch. New patches added: `document.hasFocus` (overridden on both instance and Document.prototype), `Emulation.setFocusEmulationEnabled` via CDP, `document.wasDiscarded`. End result: Cloudflare Web Analytics dashboard now fully renders on backgrounded tabs without focus theft (verified live).",
    "Reverted the `navigate --new` about:blank trampoline from 0.5.17. It was opening about:blank as a stepping stone to attach before page JS ran; user-visible as a ~200ms flash. Removed — the addScriptToEvaluateOnNewDocument registration in 0.5.18 is robust enough that subsequent reloads pick up the shim cleanly.",
    "Honest caveat: shim covers visibility + focus gates. If a page detects automation via other means (chrome.runtime.connect probe, navigator.webdriver, debugger evaluation traces), chrome-relay won't help — those need stealth-mode workarounds separate from visibility."
  ],
  "0.5.17": [
    "Force-visible on attach (default-on). Modern SPAs (Cloudflare dashboard, Linear, Notion) gate their JS on `document.visibilityState` and stall on backgrounded tabs — chrome-relay's whole pitch is operate-without-stealing-focus, and that pitch silently broke whenever the page was visibility-gated. Fix runs three CDP calls on every attach: `Page.setWebLifecycleState({state:'active'})` to stop Chrome's rAF/timer throttling, plus a JS shim (installed via `Page.addScriptToEvaluateOnNewDocument` AND `Runtime.evaluate`) that overrides `document.visibilityState` / `document.hidden` so the page's own checks see 'visible.'",
    "Scoped to debugger-attached tabs only — other tabs the user has open stay normally throttled. Override clears when chrome-relay detaches. User's viewport never changes.",
    "Behavioral guidance: never call `chrome-relay switch` to make a backgrounded SPA render — it stalls because of visibility gating, not chrome-relay. The new attach behavior fixes it invisibly.",
    "Tests: +4 in apps/extension/test/force-visibility.test.ts. Total 426 (was 422)."
  ],
  "0.5.16": [
    "chrome_hover now rejects partial-coordinate intent (`--x 10` without `--y`, or vice versa) instead of silently falling through to selector-mode and losing the half-passed coordinate. CLI forwards even partial input so the protocol parser sees it.",
    "Network body errors are now structured RelayError instead of plain Error. `getBody` for a request that's not in the buffer → `target_not_found`; CDP failure (Chrome GC'd the body, permission denied, etc.) → `cdp_error` with the original message under `details.underlying`. Agents can branch on the code instead of pattern-matching the message.",
    "Console truncation cap (1000 chars) consolidated into limits.ts as CONSOLE_ENTRY_TEXT_MAX_CHARS / CONSOLE_ENTRY_STACK_MAX_CHARS. 4 hardcoded sites in console-buffer.ts now reference the constants.",
    "CLI help text interpolates limits from @chrome-relay/protocol. `chrome-relay network --help` and `chrome-relay console --help` no longer hardcode '200' or '256 KB' — they read from NETWORK_BUFFER_MAX_ENTRIES / CONSOLE_BUFFER_MAX_ENTRIES / CONSOLE_BUFFER_MAX_BYTES. Future bumps propagate without manual edits.",
    "Removed the PER_TAB_MAX / PER_TAB_MAX_BYTES alias indirection in network-buffer.ts and console-buffer.ts. The protocol constants have good names; aliasing them was leftover from before they existed.",
    "Softened the over-claiming parser comments in args/index.ts and shared.ts — they correctly describe the extension as the trust boundary that runs the parsers (CLI doesn't pre-validate today; that's a documented future PR).",
    "Tests: +1 hover partial-coord + 2 network getBody structured-error coverage. Total 417 (was 416)."
  ],
  "0.5.15": [
    "Tab-id coercion is now strict against blank strings. `--tabs '1,,3'` (or `[\"\"]`, or `[' ']`) used to silently become `[1, 0, 3]` because Number('') === 0 — and tab 0 is a real Chrome target. Now throws RelayError(invalid_arguments). Affects chrome_group create/add/remove, chrome_switch_tab, chrome_close_tabs.",
    "Numeric range validation added across the parsers. `optPositiveNumber` (> 0) and `optNonNegativeNumber` (>= 0) helpers reject out-of-range values at the parser boundary instead of letting nonsense through to CDP / handler logic. Affects: chrome_evaluate timeoutMs, chrome_screenshot maxEdge + padding, chrome_screencast quality/maxWidth/maxHeight/everyNthFrame, chrome_network body head.",
    "chrome_screenshot maxEdge <= 0 now throws instead of being silently ignored (was the one remaining `if (x > 0)` silent-drop in the parsers).",
    "No-args parser comment + behavior aligned. parseGetWindowsAndTabsArgs / parseChromeSelfReloadArgs validate the input is at least an object (rejects strings/arrays) but accept any extra fields. Both handlers now call their parser at the top for consistency with every other tool.",
    "New @chrome-relay/protocol exports: shared numeric limits in `packages/protocol/src/limits.ts`. Constants (DEFAULT_TOOL_CALL_TIMEOUT_MS, DEFAULT_EVAL_TIMEOUT_MS, DEFAULT_BODY_PREVIEW_BYTES, NETWORK_BUFFER_MAX_ENTRIES/BYTES, CONSOLE_BUFFER_MAX_ENTRIES/BYTES, etc.) now flow from one source — bridge.ts, console-buffer.ts, network-buffer.ts, and the network/evaluate handlers all import. Future doc/help drift is structurally prevented.",
    "Tests: +9 in args-all.test.ts covering blank-string rejection, range validation across screenshot/evaluate/screencast/network. Total 416 (was 407)."
  ],
  "0.5.14": [
    "Optional parser fields are now strict — passing a present-but-wrong-type value (e.g. `{newTab: 'yes'}` instead of `true`) throws RelayError(invalid_arguments) instead of silently being dropped. undefined/null still means 'caller omitted the field' and the handler uses its default.",
    "parseTargetArgs is strict too: `{tabId: '5'}` rejects (numeric tabId required). Navigate is the one exception — it coerces string tabId for back-compat since it's used as a 'reference window' rather than a strict target.",
    "CLI tab-group --tabs arg now forwarded as the raw comma-separated string. The protocol parser (parseChromeGroupArgs) does the strict per-element parsing so `--tabs 1,foo,3` errors instead of silently becoming [1,3].",
    "Deleted the dead duplicate parser module at apps/extension/src/browser/parsers.ts and its test file. The protocol parsers replace them; behavior identical.",
    "HAR creator.version now reads from chrome.runtime.getManifest() instead of the hardcoded stale '0.2.x'. Drift-proof.",
    "New CLI helper `withBase(opts, extras)` collapses the `const args = {}; Object.assign(args, baseArgs(opts)); args.foo = bar` pattern into one expression. All four command modules migrated — `Object.assign(args, baseArgs(opts))` is gone from the codebase.",
    "Tests: +2 strict-optional cases. Total 407 (was 433 — 28 dropped were duplicates of protocol parsers)."
  ],
  "0.5.13": [
    "Protocol arg-parser coverage complete (code-quality-hardening Risk 1 — finished). Every one of the 22 tools now has an executable parser in @chrome-relay/protocol that returns a typed args object with `code:'invalid_arguments'` errors on malformed input.",
    "New parsers in this release: parseChrome{ReadPage,Click,Fill,Keyboard,Type,Evaluate,SwitchTab,CloseTabs,Ax,ClickAx,Screenshot,Viewport,Console,Workspace,Group,Screencast}Args, plus parseGetWindowsAndTabsArgs and parseChromeSelfReloadArgs.",
    "All extension handlers now consume their parser at the top of the handler body — silent shape drift between CLI and extension is structurally impossible.",
    "Multi-action tools (viewport, console, network, workspace, group, screencast) return discriminated unions so the handler branches with TypeScript narrowing instead of `typeof args.action === 'string'` boilerplate.",
    "36 new tests in packages/protocol/test/args-all.test.ts. Total now 433 (was 397)."
  ],
  "0.5.12": [
    "Protocol-owned tool arg parsers (code-quality-hardening Risk 1). New @chrome-relay/protocol exports: `parseChromeNavigateArgs`, `parseChromeHoverArgs`, `parseChromeNetworkArgs`. Each is the single source of truth for what its tool accepts — CLI and extension consume the same parser so silent shape drift can't happen.",
    "Pattern established with 3 representative tools (navigate, hover, network — the doc-followup explicitly named these). Remaining 19 tools are mechanical follow-up (~20 lines + tests each). Each parser throws `RelayError(invalid_arguments)` with field/received/validChoices in details.",
    "chrome_hover handler refactored to use the new parser end-to-end. Hover args now collapse into a discriminated union (`{kind:'selector', selector}` | `{kind:'coords', x, y}`) so the handler branches without re-doing the typeof dance.",
    "19 new tests in packages/protocol/test/args.test.ts. Total now 397."
  ],
  "0.5.11": [
    "Tests-only: 6 new edge-case tests for `chrome-relay update`. Covers --dry-run, install failure, install-success-but-binary-version-unchanged (PATH mismatch / stale shim), install-success-but-which-fails, install-success-but-release-notes-parse-fails, and the happy path. Locks in the structured-metadata contract from 0.5.7.",
    "Total tests now 378 (was 372)."
  ],
  "0.5.10": [
    "Direct /call target conflict enforcement. Third-party callers posting to /call with multiple loose target fields (tabId + workspaceName, etc.) now throw `target_conflict` instead of silently applying precedence. Matches the CLI rule the CLI itself enforced since 0.5.4.",
    "All useful plain Error throws in extension handlers converted to RelayError(invalid_arguments). Affected tools: chrome_click_element, chrome_fill_or_select, chrome_keyboard, chrome_type, chrome_evaluate, chrome_switch_tab, chrome_close_tabs, chrome_viewport (preset name + width/height), chrome_workspace (create/close), chrome_group (create/close/add/remove), chrome_network (body without --request-id), chrome_hover (no selector or x,y), chrome_click_ax (no --node), and bbox parser. Agents can now branch on `errorDetails.code === 'invalid_arguments'` for all of these.",
    "chrome_hover with a selector that doesn't match now throws RelayError(`element_not_found`) (was plain Error).",
    "BEHAVIOR CHANGE — `chrome-relay screencast stop --gif/--mp4` is no longer best-effort when ffmpeg is missing. Old behavior printed 'skipping' and exited 0 (agent saw success but no GIF existed). New behavior throws `external_dependency_missing` with exit 1. Pass `--allow-missing-ffmpeg` to restore the legacy skip-with-warning behavior.",
    "Tests: +17 in handler-strict.test.ts covering the conflict + 13 missing-arg paths. Total now 372."
  ],
  "0.5.9": [
    "Internal refactor (code-quality-hardening PR 7): program.ts and tools.ts split into per-domain modules. Pure code motion, no behavior change.",
    "CLI: packages/cli/src/program.ts shrank from 1041 → 75 lines. Per-domain modules now live in packages/cli/src/commands/{install-update,navigation,input,capture,sessions}.ts.",
    "Extension: apps/extension/src/browser/tools.ts shrank from 891 → 34 lines. Per-domain handler modules live in apps/extension/src/browser/handlers/{target,navigation,input,capture,sessions}.ts.",
    "All 355 tests still pass without modification — the dispatcher contract (runTool name dispatch) is unchanged."
  ],
  "0.5.8": [
    "Internal refactor (code-quality-hardening PR 6, first cut): shared CLI helpers moved out of program.ts into packages/cli/src/commands/shared.ts.",
    "tabOpt(), makeBaseArgs(program), and runTool() are now importable from `./commands/shared.js`. program.ts dropped ~100 lines.",
    "No behavior change — all 355 tests still pass. Future PRs can split per-domain command groups (navigation, input, capture, sessions) into their own modules without churning helpers."
  ],
  "0.5.7": [
    "`chrome-relay update` returns structured verification metadata (code-quality-hardening PR 5). Output now has `install: { attempted, packageManager, status, command }`, `binary: { path, reexeced }`, `releaseNotes: { source: 'current_process' | 'updated_binary', changes }`, and a `warnings[]` array.",
    "Surfaces the 'install said success but binary didn't change' failure mode (PATH mismatch, stale shim, cross-package-manager confusion) as `warnings[].code === 'update_not_verified'`. Agents can branch on it.",
    "Falls back gracefully: when the re-exec can't be proven, release notes are read from the current (pre-update) process and marked `source: 'current_process'`. The agent knows the bullets may be stale."
  ],
  "0.5.6": [
    "BEHAVIOR CHANGE — `chrome-relay network har --with-bodies` is now strict by default (code-quality-hardening PR 4). When ANY body fails to fetch, the call throws `partial_success_disallowed` with details about which entries failed.",
    "New `--best-effort-bodies` flag restores the legacy behavior: HAR still emits, missing/errored bodies are recorded per-entry in `_chrome_relay.bodyState` and `_chrome_relay.bodyError` (with code, message, and phase).",
    "New `bodyState: 'error'` value (was just 'missing' before). 'error' fires when the CDP call threw; 'missing' fires when the body returned empty. Lets the caller distinguish 'Chrome GC'd it' from 'still in flight' from 'permission denied.'"
  ],
  "0.5.5": [
    "BEHAVIOR CHANGE — `chrome_navigate --new` no longer silently falls back to 'wherever Chrome picks' when an explicit routing intent fails (code-quality-hardening PR 3).",
    "`navigate --new --tab <id>` where <id> doesn't exist now throws `target_not_found` instead of silently letting Chrome drop the tab in the focused (often the user's) window.",
    "`navigate --new --group <name>` where the group-join fails now throws `partial_success_disallowed`. The new tab IS created (we don't roll back) so the agent can clean it up; the error details include `createdTabId` and `groupName`.",
    "Both new strict paths accept `allowPartial: true` as an arg to opt back into the legacy best-effort behavior. With allowPartial, the success result carries `partial: true` and a `warnings[]` array naming what didn't happen.",
    "Tightened `chrome_navigate` argument errors to RelayError(invalid_arguments) — missing url, non-numeric tabId."
  ],
  "0.5.4": [
    "Strict target routing (code-quality-hardening PR 2). Within a single scope, --tab / --workspace / --group are mutually exclusive — passing more than one on the same subcommand (or both at the program level) now fails with `target_conflict` and exit code 2.",
    "Cross-scope override is still allowed but visible: `chrome-relay --workspace W <cmd> --workspace W2` works, but stderr prints a `target_overridden: workspace W → W2` notice so the agent (or user) knows what happened.",
    "Fixed silent drops: `viewport set` and `console` previously hand-rolled their args and ignored global --workspace/--group. They now route through baseArgs() like every other targetable command.",
    "New target-routing test matrix (55 tests) proves every targetable subcommand forwards --tab, --workspace, and --group correctly — and that the strict-conflict + override behavior holds. If you add a new targetable command to the CLI, add it to TARGETABLE_COMMANDS in packages/cli/test/target-routing.test.ts.",
    "New TargetSelector type in @chrome-relay/protocol (future-proofing). Wire still carries the three loose fields; a future PR migrates the extension to read a single structured `target` field."
  ],
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
