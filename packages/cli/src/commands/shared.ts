// Shared CLI helpers — extracted from program.ts so the per-command
// modules can import them without circular references on the program
// object. Each helper is a pure function or takes the program instance
// as a parameter.
//
// Code-quality-hardening PR 6: first cut at splitting program.ts. The
// per-domain command modules can land in follow-up PRs; this PR is just
// the helpers so the existing program.ts can shrink without behavior
// changes.

import type { Command } from "commander";
import {
  RelayError,
  TOOL_NAMES,
  parseToolArgs,
  type ToolName
} from "@chrome-relay/protocol";
import { callTool } from "../client/call.js";

// Shared context passed to every command-group registration function.
// Each per-domain module imports CommandContext and registers its
// subcommands against ctx.program using the helpers.
export interface TargetOpts {
  tab?: number;
  workspace?: string;
  group?: string;
  profile?: string;
}

export interface CommandContext {
  program: Command;
  baseArgs: (opts: TargetOpts) => Record<string, unknown>;
  run: typeof runToolImpl;
  withBase: (opts: TargetOpts, extras?: Record<string, unknown>) => Record<string, unknown>;
}

// Helper that collapses the `const args = {}; Object.assign(args,
// baseArgs(opts)); args.foo = bar; await run(...)` pattern into one
// expression. Used by every per-domain registration module.
export function makeWithBase(
  baseArgs: (opts: TargetOpts) => Record<string, unknown>
) {
  return function withBase(
    opts: TargetOpts,
    extras?: Record<string, unknown>
  ): Record<string, unknown> {
    return { ...baseArgs(opts), ...(extras ?? {}) };
  };
}

// Attach --tab / --workspace / --group / --profile to a subcommand.
// --profile is a PARENT scope: it composes with the other three (they pick
// a tab inside one profile's Chrome), so it joins no conflict set.
export function tabOpt(cmd: Command): Command {
  return cmd
    .option("-t, --tab <id>",      "target tab ID", (v) => Number(v))
    .option("--workspace <name>",  "target the active tab in a named workspace window (see `chrome-relay workspace`)")
    .option("--group <name>",      "target the active tab in a named tab-group (see `chrome-relay group`)")
    .option("--profile <name>",    "target a connected Chrome profile by label or instanceId prefix (see `chrome-relay profile`)");
}

// Build a base args object from common options. Every subcommand that
// takes a tab/workspace/group routes through here so the precedence rules
// and the conflict-rejection live in one place.
//
// Strict target rules (code-quality-hardening PR 2):
//   1. Within ONE scope (subcommand-level OR program-level), at most one
//      of --tab / --workspace / --group may be set. Two on the same
//      subcommand → reject with invalid_arguments.
//   2. ACROSS scopes, subcommand-level overrides program-level. The
//      override is allowed but emits a `target_overridden` notice on
//      stderr so the agent/user can see what happened.
//   3. --tab is mutually exclusive with --workspace/--group on the same
//      scope (a specific tab can't also "be in" a named workspace).
export function makeBaseArgs(program: Command) {
  return function baseArgs(opts: TargetOpts): Record<string, unknown> {
    const parentOpts = program.opts() as { workspace?: string; group?: string; profile?: string };

    rejectIntraScopeConflict("subcommand", {
      tab: opts.tab, workspace: opts.workspace, group: opts.group
    });
    rejectIntraScopeConflict("program-level", {
      workspace: parentOpts.workspace, group: parentOpts.group
    });

    if (opts.workspace && parentOpts.workspace && opts.workspace !== parentOpts.workspace) {
      emitTargetOverride("workspace", parentOpts.workspace, opts.workspace);
    }
    if (opts.group && parentOpts.group && opts.group !== parentOpts.group) {
      emitTargetOverride("group", parentOpts.group, opts.group);
    }
    if (opts.tab !== undefined && (parentOpts.workspace || parentOpts.group)) {
      const prior = parentOpts.workspace ? `workspace=${parentOpts.workspace}` : `group=${parentOpts.group}`;
      emitTargetOverride("tab", prior, String(opts.tab));
    }
    if (opts.profile && parentOpts.profile && opts.profile !== parentOpts.profile) {
      emitTargetOverride("profile", parentOpts.profile, opts.profile);
    }

    const args: Record<string, unknown> = {};
    if (opts.tab !== undefined) args.tabId = opts.tab;
    const effectiveWorkspace = opts.workspace ?? parentOpts.workspace;
    const effectiveGroup     = opts.group     ?? parentOpts.group;
    if (opts.tab === undefined && effectiveWorkspace) args.workspaceName = effectiveWorkspace;
    if (opts.tab === undefined && effectiveGroup)     args.groupName     = effectiveGroup;
    // --profile is a PARENT scope, orthogonal to the three above. It rides
    // as the CLI-internal `__profile` hint: callTool strips it and routes
    // by it — it never reaches the wire (an extension IS a profile; it has
    // no concept of others).
    const effectiveProfile = opts.profile ?? parentOpts.profile;
    if (effectiveProfile) args.__profile = effectiveProfile;
    return args;
  };
}

function rejectIntraScopeConflict(
  scope: "subcommand" | "program-level",
  fields: { tab?: number; workspace?: string; group?: string }
): void {
  const present: string[] = [];
  if (fields.tab !== undefined) present.push("--tab");
  if (fields.workspace) present.push("--workspace");
  if (fields.group) present.push("--group");
  if (present.length > 1) {
    process.stderr.write(
      `[chrome-relay] target_conflict: ${scope} flags ${present.join(" + ")} are mutually exclusive. Pass exactly one of --tab, --workspace, or --group on the same ${scope}.\n`
    );
    process.exit(2);
  }
}

function emitTargetOverride(kind: string, from: string, to: string): void {
  process.stderr.write(
    `[chrome-relay] target_overridden: ${kind} ${from} → ${to} (subcommand-level overrides program-level)\n`
  );
}

// Standard tool-result printer. JSON for objects, raw string for strings.
// RelayError gets a structured stderr dump alongside the human message so
// agents can parse `{relayError: {...}}` mechanically without a separate flag.
async function runToolImpl(name: string, args: Record<string, unknown>): Promise<void> {
  try {
    // Peel the CLI-internal routing hint off before validation and wire.
    let profile: string | undefined;
    if (typeof args.__profile === "string") {
      profile = args.__profile;
      args = { ...args };
      delete args.__profile;
    }
    // Validate locally so bad input fails fast with the same structured
    // RelayError the extension would produce — but transmit the RAW args.
    // Parsers run at BOTH ends on the same raw shape; some (chrome_wait)
    // transform their output, so sending parse output would make the
    // extension re-parse a shape it doesn't accept. Caught live in 0.7.0:
    // `wait .sel` validated fine here, then died extension-side with
    // "got 0 conditions" because the wire carried {condition} not {selector}.
    if (isToolName(name)) parseToolArgs(name, args);
    const result = await callTool(name, args, { profile });
    if (typeof result === "string") {
      process.stdout.write(result + "\n");
    } else {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
  } catch (error) {
    if (error instanceof RelayError) {
      process.stderr.write(error.message + "\n");
      process.stderr.write(JSON.stringify({ relayError: error.toBridgeError() }, null, 2) + "\n");
    } else {
      process.stderr.write(
        (error instanceof Error ? error.message : String(error)) + "\n"
      );
    }
    process.exit(1);
  }
}

export const runTool = runToolImpl;

function isToolName(name: string): name is ToolName {
  return (Object.values(TOOL_NAMES) as string[]).includes(name);
}
