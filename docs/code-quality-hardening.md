# Chrome Relay code quality hardening

Status: draft for review, written 2026-05-17. Updated after a third pass
against the current worktree: most of the hardening plan has now landed.

This document is a code-quality review and hardening proposal for the current
Chrome Relay codebase. It focuses on the parts that matter most for agent use:
clear input/output contracts, transparent errors, no hidden fallbacks, and code
that can keep improving without becoming a pile of special cases.

It is based on a local review of:

- `packages/protocol/src/index.ts`
- `packages/cli/src/program.ts`
- `packages/cli/src/client/call.ts`
- `packages/cli/src/http/server.ts`
- `packages/cli/src/native/bridge.ts`
- `apps/extension/src/bridge/native-host.ts`
- `apps/extension/src/browser/tools.ts`
- `apps/extension/src/browser/cdp.ts`
- `apps/extension/src/browser/page-actions.ts`
- `apps/extension/src/browser/network-buffer.ts`
- `docs/issues.md`
- `docs/whats-left.md`
- `TESTING.md`

The current test suite is healthy: `pnpm typecheck`, `pnpm test`, and
`pnpm test:e2e` all pass locally at the time of this review.

## Executive summary

Chrome Relay has the right architecture: a thin CLI, a local HTTP/native bridge,
and the Chrome extension as the actual browser-control executor. The test suite
is better than the average early tool of this kind, especially the fixture-based
E2E tests. The code also shows a strong bias toward real CDP primitives instead
of synthetic browser automation.

The original review found a clear pattern: the surface area was growing inside
two large router files, `packages/cli/src/program.ts` and
`apps/extension/src/browser/tools.ts`, while several fallback paths could still
return success after doing something different from what the caller asked for.
Most of that has now been addressed. `program.ts` is an assembly file, tool
handlers are split by domain, strict parsers exist, structured errors/notices
are on the wire, target routing has a matrix test, navigation fallbacks are
strict by default, HAR bodies are strict by default, and update returns
verification metadata.

The highest-leverage remaining changes are narrower:

1. Move tool argument schemas into `packages/protocol`; today protocol owns
   error/notice/target types, but most arg validation still lives in extension
   parsers and handler code.
2. Enforce strict target conflicts at the extension boundary too. The CLI
   rejects same-scope conflicts, but direct `/call` users can still send loose
   `tabId` + `workspaceName` + `groupName` fields and get precedence behavior.
3. Finish converting older handler errors to `RelayError` instead of plain
   `Error` where useful.
4. Add or confirm tests for update verification edge cases.

## Current status snapshot

Most of the recommendations in this document have now been executed. Reviewers
should treat this as a status-aware hardening record plus a short remaining
worklist, not a fresh plan.

Already landed:

- `BridgeError`, `BridgeNotice`, `RelayError`, `TargetSelector`, and generic
  `BridgeResponse<T>` exist in `packages/protocol`.
- The extension serializes `errorDetails` alongside legacy `error`.
- The native bridge and HTTP bridge preserve structured errors.
- HTTP responses include structured `notices[]` alongside legacy `notice`.
- CLI call handling understands structured errors/notices.
- CLI same-scope target conflicts now fail with `target_conflict`.
- Cross-scope target overrides emit a visible `target_overridden` notice.
- A target forwarding matrix covers targetable CLI commands.
- `viewport set` and `console` now route through shared `baseArgs()` behavior.
- `chrome_navigate --new --tab <id>` fails if the reference tab cannot be
  resolved unless `allowPartial: true` is passed.
- `chrome_navigate --new --group <name>` fails with
  `partial_success_disallowed` if group join fails unless `allowPartial: true`
  is passed.
- HAR `--with-bodies` is strict by default.
- HAR best-effort behavior is explicit via `bestEffortBodies` /
  `--best-effort-bodies`.
- HAR body fetch failures include `_chrome_relay.bodyError`.
- `chrome-relay update` returns structured install/binary/release-note
  verification metadata and warnings.
- `packages/cli/src/program.ts` is split into command modules under
  `packages/cli/src/commands/`.
- `apps/extension/src/browser/tools.ts` is split into handler modules under
  `apps/extension/src/browser/handlers/`.
- Strict pure parsers exist in `apps/extension/src/browser/parsers.ts`.
- Tab-group tab IDs now reject invalid values instead of filtering them out.
- Tab-group colors now reject invalid values.
- Console levels now reject invalid values.
- Network status buckets now reject invalid values.
- Console and network actions now reject unknown `action` values.
- Screencast format now rejects unsupported values.
- Parser unit tests exist in `apps/extension/test/strict-parsers.test.ts`.

Partially landed:

- Protocol owns response, notice, error, and target types, but not executable
  per-tool argument schemas.
- Extension handlers consume the new strict parser module.
- The CLI rejects target conflicts, but direct `/call` payloads are still loose
  and resolved by extension precedence for backward compatibility.

Still open:

- Move or mirror per-tool argument schemas into `packages/protocol`.
- Make the extension reject conflicting target fields from direct `/call`
  callers, or explicitly document the compatibility precedence as a legacy
  direct-call behavior.
- Convert remaining older plain `Error` throws where structured agent branching
  would help.
- Add explicit update-command tests around failed install, unchanged binary, and
  release-note parse failure if not already covered elsewhere.

## Product principle

Chrome Relay is built for agents. That changes the code-quality bar.

A human CLI can sometimes recover from ambiguity by reading prose, retrying, or
noticing that the browser went somewhere unexpected. An agent usually cannot. It
will treat a successful JSON result as truth and build the next step on top of
it.

So the product rule should be:

> If Chrome Relay cannot do exactly what was requested, it should fail with a
> precise error. If partial success is intentionally allowed, partial success
> must be explicit in the output shape.

That means:

- no silent fallback from a requested tab/window/group to "whatever Chrome picks"
- no silent dropping of invalid enum values
- no "best effort" behavior unless the command or flag says best effort
- no error flattening that erases where the failure happened
- no success result that hides an important warning in stderr only

## Current architecture

The runtime path is:

```text
agent / shell
  -> chrome-relay CLI
  -> local HTTP bridge at 127.0.0.1:12122
  -> native messaging host
  -> Chrome extension background service worker
  -> browser tool handler
  -> Chrome extension APIs and CDP
  -> real tabs in the user's Chrome profile
```

Main packages:

- `packages/protocol`: shared constants and bridge message types
- `packages/cli`: CLI parser, local bridge client, native host, install/update
- `apps/extension`: extension runtime, popup, CDP/browser tools

This split is good. The remaining weak spot is that `packages/protocol`
currently defines tool names plus response/error/notice/target types, but it
does not define executable per-tool input schemas. As a result, the CLI and
extension still interpret `Record<string, unknown>` independently for most tool
arguments.

## What is good today

The codebase already has several strong choices that should be preserved.

### Thin browser-control core

Chrome Relay is not trying to become a workflow builder. The tool surface is
mostly direct browser operations: navigate, read, click, fill, type, keys,
screenshot, AX tree, console, network, viewport, workspaces, tab groups, and
screencast. That is the right scope.

### Real CDP input where it matters

Clicking uses CDP `Input.dispatchMouseEvent`, typing uses `Input.insertText`,
keyboard uses `Input.dispatchKeyEvent`, and JS uses `Runtime.evaluate`. This is
the difference between "looks clicked" and "the target site actually accepts the
interaction."

### Useful E2E fixtures

The E2E suite is framed around concrete failure modes:

- React controlled input
- Lexical/contenteditable typing
- trusted click events
- dynamic element failure
- special keyboard keys
- JS async/main-world access
- shadow DOM limitations
- background tab screenshots
- debugger conflict recovery

This is exactly the right testing style for an agent-facing browser bridge.

### Honest documentation

`docs/issues.md`, `docs/whats-left.md`, and `TESTING.md` are concrete. They
describe what shipped, what broke, and what remains. Keep that style.

## Main risks

### Risk 1: protocol drift

Status: mostly executed.

`packages/protocol/src/index.ts` now owns `BridgeError`, `BridgeNotice`,
`BridgeResponse<T>`, `RelayError`, `toBridgeError`, and `TargetSelector`.
The HTTP server emits both legacy `notice: string` and structured
`notices: BridgeNotice[]`. Extension and bridge error paths preserve
`errorDetails`.

The remaining drift is per-tool argument validation. `ToolArguments` is still:

```ts
export type ToolArguments = Record<string, unknown>;
```

That means the protocol package names tools and response/error shapes, but does
not yet define executable schemas for `chrome_network`, `chrome_console`,
`chrome_navigate`, etc. Those rules live in extension parsers/handlers and CLI
command code.

Current target shape:

```ts
export interface BridgeNotice {
  code: BridgeNoticeCode;
  message: string;
  details?: Record<string, unknown>;
  action?: {
    command: string;
  };
}

export type BridgeResponse<T = unknown> =
  | { ok: true; data: T; notice?: string; notices?: BridgeNotice[] }
  | { ok: false; error: string; errorDetails?: BridgeError; notice?: string; notices?: BridgeNotice[] };
```

Remaining recommendation:

- Add per-tool argument schemas to `packages/protocol`.
- Use those schemas in the CLI, HTTP bridge, and extension boundary.
- Keep legacy string fields until a major version removes them.

### Risk 2: errors are flattened too early

Status: mostly executed.

The original problem was that extension errors were converted to strings and
then rewrapped through the native bridge and HTTP bridge. That is no longer the
normal path. Handlers can throw `RelayError`; the extension serializes
`errorDetails`; the native bridge reconstructs `RelayError`; the HTTP bridge
preserves `errorDetails`; the CLI prints a `{ relayError: ... }` JSON object to
stderr for structured consumers.

Current shape:


```ts
export interface BridgeError {
  code:
    | "invalid_arguments"
    | "unsupported_tool"
    | "target_not_found"
    | "target_conflict"
    | "element_not_found"
    | "cdp_error"
    | "chrome_api_error"
    | "timeout"
    | "native_host_disconnected"
    | "extension_not_connected"
    | "external_dependency_missing"
    | "partial_success_disallowed"
    | "internal_error";
  message: string;
  tool?: ToolName;
  phase?: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}
```

Then the downstream agent can reason mechanically:

- `target_not_found`: rerun `tabs`
- `element_not_found`: rerun `read` or `ax`
- `target_conflict`: fix CLI args
- `external_dependency_missing`: install `ffmpeg` or omit `--gif`
- `timeout`: maybe retry or increase timeout
- `invalid_arguments`: do not retry; fix the call

The human-readable `message` still matters, but it should not be the only
contract.

Remaining recommendation:

- Continue converting old plain `Error` throws to `RelayError` where the caller
  can usefully branch on `code`, `phase`, or `details`.
- Avoid adding new string-only errors in handlers.

### Risk 3: silent fallbacks

Status: executed for the navigation paths called out in the original review.

`chrome_navigate --new --tab <id>` now rejects missing/non-numeric reference
tabs instead of letting Chrome pick a window. `chrome_navigate --new --group
<name>` now rejects group-join failure with `partial_success_disallowed` instead
of returning plain success. The legacy permissive behavior is available only via
`allowPartial: true`, and success then carries `partial: true` plus warnings.

Current rule:

- Fail by default when an explicit target or grouping operation cannot be
  honored.
- If partial success is useful, expose it through an explicit flag such as
  `allowPartial: true`.
- When partial success occurs, return a result whose status is not plain
  success.

Example:

```json
{
  "ok": false,
  "error": {
    "code": "partial_success_disallowed",
    "message": "Created tab 123 but failed to add it to group research.",
    "tool": "chrome_navigate",
    "phase": "join_tab_group",
    "details": {
      "createdTabId": 123,
      "groupName": "research"
    }
  }
}
```

Or, if explicitly allowed:

```json
{
  "tabId": 123,
  "windowId": 9,
  "url": "https://example.com",
  "partial": true,
  "warnings": [
    {
      "code": "group_join_failed",
      "message": "Tab was created but could not be added to group research."
    }
  ]
}
```

### Risk 4: inconsistent routing arguments

Status: executed at the CLI boundary.

The CLI advertises `--tab`, `--workspace`, and `--group` as common target
selectors. The extension has a shared resolver:

```ts
resolveTarget(args)
```

The original drift sites were `viewport set` and `console`; both are now covered
by shared `baseArgs()` behavior. `packages/cli/test/target-routing.test.ts`
contains a matrix for targetable commands and explicit regressions for those two
cases.

Current CLI rule:

- Every command that targets a tab should use the same helper.
- Same-scope target conflicts are rejected with `target_conflict` and exit code
  2.
- Cross-scope overrides are allowed but emit `target_overridden` on stderr.

Remaining caveat:

- Direct `/call` users can still post loose conflicting fields. The extension
  resolver preserves old precedence behavior for backward compatibility:

```text
--tab > --group > --workspace > active tab
```

For agent use, strict mode is better:

- Either make the extension reject conflicting direct-call fields too, or
  document this as a legacy compatibility behavior.

Example strict error:

```json
{
  "code": "target_conflict",
  "message": "Pass only one target selector: --tab, --group, or --workspace.",
  "details": {
    "received": ["tabId", "workspaceName"]
  }
}
```

### Risk 5: invalid enums are silently dropped

Status: executed in the extension; still not protocol-owned.

Earlier versions had parsers that intentionally ignored invalid input:

- tab id parser drops non-numeric values
- color parser returns `undefined` for an invalid color
- console level parser drops unknown levels
- network status is cast to a union without validation

This makes bad input look like missing input or unfiltered output.

For example, if an agent asks:

```sh
chrome-relay console --level errors
```

and `errors` is silently dropped, the agent may receive all levels instead of
only errors. That is worse than failing.

Current implementation:

- `apps/extension/src/browser/parsers.ts` provides strict parsers for tab IDs,
  tab-group colors, console levels, and network status buckets.
- `apps/extension/src/browser/tools.ts` uses those parsers for `chrome_group`,
  `chrome_console`, and `chrome_network`.
- `apps/extension/test/strict-parsers.test.ts` covers valid and invalid values.
- Unknown `chrome_console` and `chrome_network` actions now throw instead of
  falling through to read behavior.

Remaining recommendation:

- Keep the rule: required enums reject invalid values with
  `invalid_arguments`; optional filters reject invalid values if they are
  present; omitted values are the only defaults.
- Move the schema/validation contract up into `packages/protocol` so the CLI,
  HTTP bridge, and extension share the same rules.

Example:

```json
{
  "code": "invalid_arguments",
  "message": "Invalid console level \"errors\". Expected one of: log, info, warn, error, debug, exception.",
  "tool": "chrome_console",
  "phase": "parse_arguments"
}
```

### Risk 6: best-effort HAR body export hides the cause

Status: executed.

`buildHar(..., withBodies)` now records `bodyState` as `fetched`, `skipped`,
`missing`, or `error`. When a body fetch throws, `_chrome_relay.bodyError`
contains `code`, `message`, and `phase`. `--with-bodies` is strict by default:
if any body is missing or errored, the call throws
`partial_success_disallowed`. The old permissive behavior is explicit via
`bestEffortBodies: true` / `--best-effort-bodies`.

Example HAR metadata:

```json
"_chrome_relay": {
  "requestId": "12345.67",
  "bodyState": "missing",
  "bodyError": {
    "code": "cdp_error",
    "message": "Response body is no longer available.",
    "phase": "Network.getResponseBody"
  }
}
```

### Risk 7: `program.ts` is doing too much

Status: executed.

`packages/cli/src/program.ts` is now a small assembly file. Command bodies live
under `packages/cli/src/commands/`:

```text
packages/cli/src/commands/
  capture.ts
  input.ts
  install-update.ts
  navigation.ts
  sessions.ts
  shared.ts
```

This is the intended shape. Future work should keep new command surfaces in the
closest domain module rather than rebuilding a large `program.ts`.

### Risk 8: `tools.ts` is doing too much

Status: executed.

`apps/extension/src/browser/tools.ts` is now a dispatcher that merges handler
maps. Handler bodies live under `apps/extension/src/browser/handlers/`:

```text
apps/extension/src/browser/handlers/
  capture.ts
  input.ts
  navigation.ts
  sessions.ts
  target.ts
```

This also makes ownership clearer. A network change should not accidentally
touch click behavior.

### Risk 9: update behavior is agent-hostile

Status: mostly executed.

`chrome-relay update` now returns structured metadata: install attempted/status,
package manager, active binary path, whether the updated binary was verified,
release-note source, and warnings. The remaining work is test coverage for edge
cases such as failed install, unchanged active binary, and release-note parse
failure.

Current target shape:

```json
{
  "updatedFrom": "0.5.1",
  "updatedTo": "0.5.2",
  "install": {
    "attempted": true,
    "packageManager": "npm",
    "status": 0
  },
  "binary": {
    "path": "/opt/homebrew/bin/chrome-relay",
    "reexeced": true
  },
  "releaseNotes": {
    "source": "updated_binary",
    "changes": []
  }
}
```

If the command cannot prove the active binary changed, return:

```json
{
  "install": { "attempted": true, "status": 0 },
  "binary": { "reexeced": false },
  "releaseNotes": { "source": "current_process" },
  "warnings": [
    {
      "code": "update_not_verified",
      "message": "Install completed but chrome-relay could not verify that the active binary changed."
    }
  ]
}
```

For an agent, "not verified" is critical information.

## Proposed target architecture

### 1. Protocol owns the contract

`packages/protocol` should own:

- tool names
- argument schemas
- result schemas where practical
- error schema
- notice schema
- command metadata

It does not need to become heavy. Even a small in-house validator is better than
independent `Record<string, unknown>` parsing in every layer.

Example:

```ts
export interface ToolSpec<TArgs, TResult> {
  name: ToolName;
  parseArgs(input: unknown): TArgs;
  describeArgs(args: TArgs): string;
}

export const chromeConsoleSpec: ToolSpec<ChromeConsoleArgs, ChromeConsoleResult> = {
  name: TOOL_NAMES.CONSOLE,
  parseArgs: parseChromeConsoleArgs,
  describeArgs: describeChromeConsoleArgs
};
```

Then:

- CLI uses the schema to build/validate outgoing args.
- HTTP bridge validates unknown `call` payloads before forwarding.
- Extension validates again at the trust boundary.
- Tests assert schema behavior once.

### 2. Errors are values, not strings

Use a `RelayError` class internally and serialize it at boundaries.

Example:

```ts
throw new RelayError({
  code: "element_not_found",
  message: `Element not found for selector: ${selector}`,
  tool: TOOL_NAMES.CLICK,
  phase: "locate_element",
  details: { selector },
  retryable: false
});
```

At the CLI boundary:

- default human output prints `message`
- structured stderr prints `{ relayError: ... }` for `RelayError`
- agent callers get the full object through the bridge via `errorDetails`

### 3. Best effort is explicit

Adopt this rule:

> Any operation with lossy, partial, fallback, or skipped behavior must require a
> flag or return a visible warning/result field.

Examples:

- HAR bodies can be `--best-effort-bodies`.
- `navigate --new --group` should fail if group insertion fails, unless
  `allowPartial: true` is passed.
- `screencast stop --gif` should fail if `ffmpeg` is missing, unless
  `--allow-missing-ffmpeg` or `--frames-only` is passed.
- Invalid filters should fail, not be ignored.

### 4. Target selection is one module

Create a shared target type:

```ts
export type TargetSelector =
  | { kind: "active" }
  | { kind: "tab"; tabId: number }
  | { kind: "workspace"; name: string }
  | { kind: "group"; name: string };
```

CLI converts flags into this shape. Extension resolves this shape. There is no
loose object with three optional fields.

If compatibility requires the existing `tabId`, `workspaceName`, `groupName`
shape on the wire, parse it immediately into `TargetSelector` at the extension
boundary and reject conflicts there.

### 5. Result shapes should expose intent

Agent-facing results should make it clear what happened.

Example navigation result:

```ts
export interface ChromeNavigateResult {
  tabId: number;
  windowId: number;
  url: string;
  target: TargetSelector;
  createdNewTab: boolean;
  joinedGroup?: {
    name: string;
    groupId: number;
  };
}
```

Example screenshot result:

```ts
export interface ChromeScreenshotResult {
  tabId: number;
  windowId: number;
  dataUrl: string;
  capture: {
    kind: "viewport" | "full_page" | "bbox" | "selector";
    selector?: string;
    bbox?: { x: number; y: number; width: number; height: number };
    padding?: number;
  };
  downscaled?: {
    from: { width: number; height: number };
    to: { width: number; height: number };
  };
}
```

These shapes cost a little code and save a lot of debugging.

## Implementation plan

This should be a series of small PRs. Do not do this as a giant rewrite.

### PR 1: protocol response contract

Status: complete for response/error/notice contract.

Completed:

- Add `BridgeError`, `BridgeNotice`, and generic `BridgeResponse<T>` to
  `packages/protocol`.
- Update extension native-host response serialization.
- Update CLI native bridge deserialization.
- Update HTTP response shape.
- Add unit tests for preserving structured errors and notices.

Remaining adjacent work:

- Add executable per-tool argument schemas to protocol.

### PR 2: strict target selector

Status: mostly complete at the CLI boundary.

Completed:

- Add `TargetSelector` in protocol.
- Add CLI helper to parse target flags.
- Update every targetable command to use the helper.
- Add a command matrix test proving `--tab`, `--workspace`, and `--group` are
  forwarded consistently.
- Reject same-scope conflicts in the CLI.
- Emit `target_overridden` for cross-scope overrides.

Remaining:

- The extension still resolves loose direct-call fields with compatibility
  precedence. Decide whether to reject direct-call conflicts now or keep that
  legacy behavior documented.

### PR 3: remove silent navigation fallbacks

Status: complete for the originally identified navigation fallbacks.

- `navigate --new --tab <id>` fails if the reference tab does not exist.
- `navigate --new --group <name>` fails if the tab cannot join the group.
- Optional explicit partial-success behavior exists through `allowPartial:
  true`, with `partial: true` and `warnings[]` in the success result.
- Negative tests exist in `apps/extension/test/navigate-strict.test.ts`.

### PR 4: strict enum/filter parsing

Status: complete in the extension, pending protocol schema ownership.

Completed:

- Console levels reject invalid values.
- Network status rejects invalid values.
- Tab group colors reject invalid values.
- Tab id lists reject invalid values instead of filtering them out.
- Unit tests exist for each parser.

Remaining:

- Move or mirror these parsers into `packages/protocol` so they become the
  shared contract instead of extension-local logic.

### PR 5: split CLI command modules

Status: complete.

- Move commands out of `program.ts` one domain at a time.
- `program.ts` now assembles command modules under `packages/cli/src/commands/`.

### PR 6: split extension tool modules

Status: complete.

- Move tool handlers out of `tools.ts`.
- `tools.ts` now dispatches to handler maps under
  `apps/extension/src/browser/handlers/`.

### PR 7: HAR body transparency

Status: complete.

- Add `bodyError` metadata.
- `--with-bodies` is strict by default.
- `--best-effort-bodies` restores permissive behavior and records per-entry
  `bodyState` / `bodyError`.

### PR 8: update command verification

Status: mostly complete.

- Return structured update metadata.
- Make release-note source explicit.
- Fail or warn loudly when re-exec cannot be verified.
- Add tests for install failure, unchanged active binary, and release-note parse
  failure if not already covered.

## Testing plan

The existing testing tiers are good. Add focused tests rather than broad
snapshots.

### Contract tests

Location:

```text
packages/protocol/test/
```

Add tests for:

- serializing/deserializing `BridgeError` (done in
  `packages/protocol/test/errors.test.ts`)
- serializing/deserializing notices (done in
  `packages/protocol/test/errors.test.ts`)
- parsing valid args for every tool (remaining, depends on protocol schemas)
- rejecting invalid enum values at the protocol boundary (remaining, depends on
  protocol schemas)
- rejecting conflicting direct-call targets at the extension/protocol boundary
  (remaining decision)

### CLI forwarding matrix

Location:

```text
packages/cli/test/target-routing.test.ts
```

For every targetable command, assert:

- `--tab` forwards tab target
- `--workspace` forwards workspace target
- global `--workspace` works
- subcommand `--workspace` overrides global if that remains supported
- `--group` forwards group target
- conflicting targets reject if strict mode is adopted

This matrix exists now and includes regressions for the old `viewport set` and
`console` drift.

### Extension resolver tests

Location:

```text
apps/extension/test/
```

Add tests for:

- active target
- tab target
- workspace target
- group target
- missing tab
- missing workspace
- missing group
- conflicting target fields

The CLI-side conflict tests are done. Extension-side direct-call conflict
behavior is still a compatibility decision.

### E2E failure fixtures

The E2E/unit suite should keep adding negative tests:

- `navigate --new --group <name>` group-join failure is covered in
  `apps/extension/test/navigate-strict.test.ts`.
- invalid console level returns `invalid_arguments`; parser unit tests cover the
  parser path.
- invalid network status returns `invalid_arguments`; parser unit tests cover
  the parser path.
- missing `ffmpeg` with `--gif` returns a structured external-dependency error
  unless the command explicitly asks for frames-only behavior.

### Regression rule

When a fallback is removed, add a test that proves the old fallback no longer
happens.

This is important because otherwise future "helpful" changes will reintroduce
fallback behavior.

## Review checklist for future features

Use this checklist before merging new Chrome Relay surfaces.

### Contract

- Is the tool name in protocol?
- Are args typed?
- Are args validated at the boundary?
- Are outputs documented as a result type?
- Are notices typed?
- Are errors typed?

### Agent transparency

- Can an agent tell exactly what happened from JSON alone?
- Are warnings visible in machine-readable output?
- Does the result include the target tab/window when applicable?
- Does partial success have an explicit field?
- Is retryability clear?

### No hidden fallback

- Does the command do exactly what was requested?
- If not, does it fail?
- If it continues, did the caller explicitly opt into best effort?
- Are invalid filters rejected instead of dropped?
- Are conflicting target flags rejected?

### Tests

- Is there a unit test for argument parsing?
- Is there a CLI forwarding test?
- Is there an extension handler test?
- Is there an E2E fixture if the behavior depends on real Chrome/CDP?
- Is there a negative test for the failure path?

## Open decisions

### Should conflicting targets fail immediately?

Recommendation: yes.

Current direct `/call` extension behavior still uses precedence:

```text
tab > group > workspace > active
```

The CLI now rejects same-scope conflicts and emits override notices across
scopes. The remaining decision is whether the extension should also reject
conflicting loose fields from direct `/call` users, or whether that precedence
stays as documented backward compatibility.

### Should HAR with bodies be strict by default?

Recommendation: yes for `--with-bodies`, with a separate best-effort option.

If a caller explicitly asks for bodies, missing bodies are important. Silent
body omission was already a real bug class in `docs/issues.md`.

Possible shape:

```sh
chrome-relay network har --with-bodies              # strict
chrome-relay network har --with-bodies --best-effort-bodies # missing bodies allowed
```

### Should CLI stderr notices also appear in JSON?

Status: yes, for bridge notices.

Stderr is useful for humans. Agents need machine-readable notices. Anything
important enough to print should also be available in structured output.

### Should `update` install at all?

Recommendation: keep `update`, but make verification explicit.

The command is useful for agents, but it crosses into package-manager behavior.
That makes it inherently environment-dependent. The command should never imply
success unless it can prove which binary is now active.

## Definition of done

This hardening effort is done when:

- `packages/protocol` defines response, notice, error, and target contracts.
  Done.
- `packages/protocol` defines executable tool arg contracts. Still open.
- CLI and extension no longer parse the same loose object independently. Partly
  open until protocol arg schemas land.
- All targetable CLI commands share one target parser. Done.
- Direct `/call` target conflicts are either rejected or explicitly documented
  as legacy precedence behavior. Still open.
- Invalid enums and filters fail loudly. Done in the extension.
- Navigation no longer silently falls back to arbitrary Chrome behavior. Done
  for the reviewed paths.
- Best-effort behavior is explicit in flags and result shapes. Done for
  navigation partials and HAR bodies.
- `program.ts` and `tools.ts` are split into domain modules. Done.
- Unit and E2E tests cover the negative paths, not only happy paths. Improved;
  continue adding negative tests with each new surface.

The codebase does not need to become over-engineered. The goal is simpler than
that: when an agent calls Chrome Relay, the call should either do exactly what
it said, or return a precise error that makes the next debugging step obvious.
