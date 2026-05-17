# Chrome Relay code quality hardening

Status: draft for review, written 2026-05-17.

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

The main risk is not that the system is broken today. The main risk is that the
surface area is growing inside two large router files:

- `packages/cli/src/program.ts`
- `apps/extension/src/browser/tools.ts`

Those files currently hold argument parsing, user-facing help, compatibility
behavior, routing decisions, business logic, output shaping, and some filesystem
post-processing. That makes incremental feature work deceptively easy. It also
makes it easy to introduce exactly the failure mode we want to avoid: "the agent
asked for X, Chrome Relay quietly did Y, and now debugging starts three layers
downstream."

The highest-leverage changes are:

1. Move the tool contracts into `packages/protocol` as executable schemas.
2. Make errors structured and preserve them across extension -> native bridge ->
   HTTP bridge -> CLI.
3. Remove silent fallback behavior from command execution paths.
4. Split the CLI and extension tool handlers by domain.
5. Add a routing/contract test matrix so every command proves it forwards
   `--tab`, `--workspace`, and `--group` consistently.

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

This split is good. The weak spot is that `packages/protocol` currently defines
tool names but does not define the full contract for tool inputs, outputs,
errors, notices, or command capabilities. As a result, the CLI and extension both
interpret `Record<string, unknown>` independently.

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

`packages/protocol/src/index.ts` defines:

```ts
export type ToolArguments = Record<string, unknown>;

export type BridgeResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
```

But the HTTP bridge now emits a `notice` field when the CLI is older than the
extension:

```ts
reply.send(notice ? { ok: true, data, notice } : { ok: true, data });
```

The implementation is reasonable, but the shared protocol type does not know
about it. That means the source of truth has drifted away from the package that
is supposed to be the source of truth.

This matters because agents depend on output shapes. If warnings/notices are
only conventionally attached by one layer, another layer can forget them without
TypeScript complaining.

Recommendation:

- Move `notice` into `BridgeResponse`.
- Add `BridgeNotice` as a typed object, not a string.
- Make `LocalBridgeCallResponse` a named export.

Example target shape:

```ts
export interface BridgeNotice {
  code: "cli_outdated";
  message: string;
  currentVersion: string;
  expectedVersion: string;
  action?: {
    command: string;
  };
}

export type BridgeResponse<T = unknown> =
  | { ok: true; data: T; notices?: BridgeNotice[] }
  | { ok: false; error: BridgeError; notices?: BridgeNotice[] };
```

### Risk 2: errors are flattened too early

The current extension catches an error and returns only:

```ts
error: error instanceof Error ? error.message : String(error)
```

Then the native bridge turns that into:

```ts
pending.reject(new Error(message.payload.error));
```

Then the HTTP bridge catches again and returns:

```ts
error: error instanceof Error ? error.message : String(error)
```

By the time the CLI prints the error, all structured information is gone. The
agent sees a string. Humans can search the string. Agents need more.

Recommendation:

Introduce a structured error shape and preserve it end-to-end.

Example:

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
    | "external_dependency_missing";
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

### Risk 3: silent fallbacks

This is the largest philosophical issue.

There are places where Chrome Relay receives a specific request, fails to honor
one part of it, and continues anyway.

Example: `chrome_navigate --new` tries to route a new tab into a referenced tab's
window. If `chrome.tabs.get(numeric)` fails, the code falls through and lets
Chrome pick a window.

Example: `chrome_navigate --new --group <name>` creates the new tab and then
attempts to add it to the named tab group. If group insertion fails, the command
still returns success for navigation.

Those choices are understandable for a human-facing CLI. They are bad defaults
for agents. An agent asked for a tab in a specific routing context. If the tab
lands somewhere else, later screenshots, reads, and clicks may operate in the
wrong workspace or user window.

Recommendation:

- Fail by default when an explicit target or grouping operation cannot be
  honored.
- If partial success is useful, expose it through an explicit flag such as
  `--allow-partial` or `bestEffort: true`.
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

The CLI advertises `--tab`, `--workspace`, and `--group` as common target
selectors. The extension has a shared resolver:

```ts
resolveTarget(args)
```

But not every CLI command forwards the shared base args consistently.

Examples:

- `viewport preset` and `viewport clear` call `baseArgs(opts)`.
- `viewport set` manually forwards only `tabId`.
- `console` manually forwards only `tabId`.

This is not a runtime failure today unless someone uses global `--workspace` or
`--group` with those commands. But it is exactly the kind of drift that grows as
more commands are added.

Recommendation:

- Every command that targets a tab should use the same helper.
- Add a unit test matrix that verifies target forwarding for each targetable
  command.
- Decide whether conflicting target flags should be rejected instead of resolved
  by precedence.

The existing precedence rule is:

```text
--tab > --group > --workspace > active tab
```

That is convenient, but it is also implicit fallback. For agent use, strict
mode is better:

- If more than one of `tabId`, `groupName`, `workspaceName` is present, reject.
- If compatibility requires precedence, make it opt-in or clearly reflected in
  output.

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

Some parsers intentionally ignore invalid input:

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

Recommendation:

- Required enums should reject invalid values with `invalid_arguments`.
- Optional filters should reject invalid values if they are present.
- Only omit the field if the user truly omitted it.

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

`buildHar(..., withBodies)` catches `getBody` failures and records only:

```ts
bodyState: "missing"
```

This is honest enough to avoid pretending the body exists, but not transparent
enough for debugging. If body fetch failed because Chrome GC'd it, because the
request was still in flight, because CDP returned a permission error, or because
the request id was stale, the caller cannot distinguish those cases.

Recommendation:

- Keep `bodyState`, but add `bodyError` when body fetching fails.
- If `withBodies` is requested, consider failing by default unless
  `bestEffortBodies: true` is set.

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

`packages/cli/src/program.ts` is now a large file that handles:

- global command construction
- help text
- update/install/release notes
- every browser command
- target option handling
- screenshot decoding
- screencast frame writing
- screencast dedupe
- `ffmpeg` invocation
- error printing

That is too much responsibility for one file. The file is still readable, but
new code will continue to land in the easiest place unless there is a better
place.

Recommendation:

Split CLI commands into modules:

```text
packages/cli/src/commands/
  core.ts
  navigation.ts
  screenshot.ts
  read.ts
  input.ts
  viewport.ts
  ax.ts
  workspace.ts
  group.ts
  network.ts
  console.ts
  screencast.ts
  update.ts
```

Shared helpers:

```text
packages/cli/src/commands/shared/
  target-options.ts
  output.ts
  errors.ts
```

The goal is not abstraction for its own sake. The goal is to make a future diff
obvious. If someone edits `commands/network.ts`, reviewers should not need to
scan 900 lines of unrelated command setup.

### Risk 8: `tools.ts` is doing too much

`apps/extension/src/browser/tools.ts` is also a large router. It handles:

- target resolution
- navigation
- screenshots
- read/click/fill/type/js
- viewport
- self reload
- AX
- workspace
- tab groups
- hover
- screencast
- console
- network
- helper parsers
- PNG downscaling
- bbox parsing

Recommendation:

Split extension tool handlers by domain:

```text
apps/extension/src/browser/tools/
  index.ts
  target.ts
  core.ts
  navigation.ts
  screenshot.ts
  input.ts
  viewport.ts
  ax.ts
  workspace.ts
  group.ts
  network.ts
  console.ts
  screencast.ts
```

The `index.ts` file should only build the handler registry:

```ts
export const handlers: ToolRegistry = {
  ...coreHandlers,
  ...navigationHandlers,
  ...screenshotHandlers,
  ...inputHandlers,
  ...viewportHandlers,
  ...axHandlers,
  ...workspaceHandlers,
  ...groupHandlers,
  ...networkHandlers,
  ...consoleHandlers,
  ...screencastHandlers
};
```

This also makes ownership clearer. A network change should not accidentally
touch click behavior.

### Risk 9: update behavior is agent-hostile

The new `update` command is useful, but its implementation currently guesses
package manager from the running binary path, installs via that package manager,
then tries to find `chrome-relay` with `which`. If it cannot prove it is running
the new binary, it falls back to local release notes.

This can produce ambiguous outcomes:

- update was attempted
- install may or may not have updated the active binary
- release notes may be from old code or new code
- the agent sees JSON that may look authoritative

Recommendation:

Return structured update metadata:

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
- `--json` output prints the full error
- agent callers get the full object through the bridge

### 3. Best effort is explicit

Adopt this rule:

> Any operation with lossy, partial, fallback, or skipped behavior must require a
> flag or return a visible warning/result field.

Examples:

- HAR bodies can be `--best-effort-bodies`.
- `navigate --new --group` should fail if group insertion fails, unless
  `--allow-partial` is passed.
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

Scope:

- Add `BridgeError`, `BridgeNotice`, and generic `BridgeResponse<T>` to
  `packages/protocol`.
- Update extension native-host response serialization.
- Update CLI native bridge deserialization.
- Update HTTP response shape.
- Add unit tests for preserving structured errors and notices.

Why first:

This creates the plumbing needed for all later hardening work.

### PR 2: strict target selector

Scope:

- Add `TargetSelector` in protocol.
- Add CLI helper to parse target flags.
- Add extension helper to resolve targets.
- Update every targetable command to use the helper.
- Add a command matrix test proving `--tab`, `--workspace`, and `--group` are
  forwarded consistently.

Decision needed:

- Keep precedence for compatibility, or reject conflicting selectors?

Recommendation:

- Reject conflicts by default.
- If compatibility is necessary, keep precedence only for one release and emit
  a typed notice.

### PR 3: remove silent navigation fallbacks

Scope:

- `navigate --new --tab <id>` fails if the reference tab does not exist.
- `navigate --new --group <name>` fails if the tab cannot join the group.
- Add optional explicit partial-success behavior only if there is a real user
  need.
- Add E2E tests for the failure paths.

Why early:

Navigation is foundational. If a tab lands in the wrong place, every later tool
call can be wrong.

### PR 4: strict enum/filter parsing

Scope:

- Console levels reject invalid values.
- Network status rejects invalid values.
- Tab group colors reject invalid values.
- Tab id lists reject invalid values instead of filtering them out.
- Add unit tests for each parser.

### PR 5: split CLI command modules

Scope:

- Move commands out of `program.ts` one domain at a time.
- Keep behavior identical.
- Do not mix behavior changes into this PR.

Review rule:

- This PR should be mostly moving code.
- Any behavior change should be deferred.

### PR 6: split extension tool modules

Scope:

- Move tool handlers out of `tools.ts`.
- Keep the registry shape.
- Keep behavior identical.
- Do not change CDP behavior in this PR.

### PR 7: HAR body transparency

Scope:

- Add `bodyError` metadata.
- Decide whether `--with-bodies` should fail by default or remain best effort.
- If keeping best effort, rename the flag or add `--strict-bodies`.

### PR 8: update command verification

Scope:

- Return structured update metadata.
- Make release-note source explicit.
- Fail or warn loudly when re-exec cannot be verified.

## Testing plan

The existing testing tiers are good. Add focused tests rather than broad
snapshots.

### Contract tests

Location:

```text
packages/protocol/test/
```

Add tests for:

- parsing valid args for every tool
- rejecting invalid enum values
- rejecting conflicting targets
- serializing/deserializing `BridgeError`
- serializing/deserializing notices

### CLI forwarding matrix

Location:

```text
packages/cli/test/program.test.ts
```

For every targetable command, assert:

- `--tab` forwards tab target
- `--workspace` forwards workspace target
- global `--workspace` works
- subcommand `--workspace` overrides global if that remains supported
- `--group` forwards group target
- conflicting targets reject if strict mode is adopted

This is the test that would have caught the current `viewport set` and `console`
drift.

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

### E2E failure fixtures

The E2E suite should add a few negative tests:

- `navigate --new --group missing` fails and does not silently create in the
  active user window.
- invalid console level returns `invalid_arguments`.
- invalid network status returns `invalid_arguments`.
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

Current behavior uses precedence:

```text
tab > group > workspace > active
```

This is convenient, but it is also a hidden decision. For agents, hidden
decisions are expensive. If the caller supplied both `--tab` and `--workspace`,
that is probably a bug in the caller. Failing early makes the bug obvious.

### Should HAR with bodies be strict by default?

Recommendation: yes for `--with-bodies`, with a separate best-effort option.

If a caller explicitly asks for bodies, missing bodies are important. Silent
body omission was already a real bug class in `docs/issues.md`.

Possible shape:

```sh
chrome-relay network har --with-bodies              # strict
chrome-relay network har --with-bodies --best-effort # missing bodies allowed
```

### Should CLI stderr notices also appear in JSON?

Recommendation: yes.

Stderr is useful for humans. Agents need machine-readable notices. Anything
important enough to print should also be available in structured output.

### Should `update` install at all?

Recommendation: keep `update`, but make verification explicit.

The command is useful for agents, but it crosses into package-manager behavior.
That makes it inherently environment-dependent. The command should never imply
success unless it can prove which binary is now active.

## Definition of done

This hardening effort is done when:

- `packages/protocol` defines response, notice, error, target, and tool arg
  contracts.
- CLI and extension no longer parse the same loose object independently.
- All targetable commands share one target parser.
- Invalid enums and filters fail loudly.
- Navigation no longer silently falls back to arbitrary Chrome behavior.
- Best-effort behavior is explicit in flags and result shapes.
- `program.ts` and `tools.ts` are split into domain modules.
- Unit and E2E tests cover the negative paths, not only happy paths.

The codebase does not need to become over-engineered. The goal is simpler than
that: when an agent calls Chrome Relay, the call should either do exactly what
it said, or return a precise error that makes the next debugging step obvious.
