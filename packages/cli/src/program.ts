// CLI entry point: builds the Command tree by registering each
// per-domain module. The actual command bodies live in commands/*.ts.
//
// Code-quality-hardening PR 7 (file split): until 0.5.8 every command was
// inline in this file (1041 lines). The doc's "split program.ts" PR is
// here: each domain gets a register() that owns its commands, this file
// is the assembly.

import { Command } from "commander";
import { CHROME_RELAY_VERSION } from "./index.js";
import { makeBaseArgs, makeWithBase, runTool, type CommandContext } from "./commands/shared.js";
import { setDefaultProfileSource } from "./client/call.js";
import { registerInstallUpdate } from "./commands/install-update.js";
import { registerNavigation } from "./commands/navigation.js";
import { registerInput } from "./commands/input.js";
import { registerCapture } from "./commands/capture.js";
import { registerSessions } from "./commands/sessions.js";
import { registerLoop } from "./commands/loop.js";
import { registerProfile } from "./commands/profile.js";
import { registerUpload } from "./commands/upload.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("chrome-relay")
    .description("Your agent drives the Chrome you're signed into. Reads pages, clicks buttons, fills forms from any shell.")
    .version(CHROME_RELAY_VERSION)
    .showHelpAfterError()
    // Global --workspace and --group flags: usable at the top level
    // (`chrome-relay --workspace W <cmd> ...`) or on the subcommand itself
    // (`chrome-relay <cmd> --workspace W ...`). Subcommands resolve the
    // effective value via baseArgs() which checks subcommand-level first,
    // then falls back to the program-level (parent) option.
    //
    //   --workspace W targets a named Chrome WINDOW (own taskbar entry)
    //   --group     G targets a named tab-GROUP (Chrome's colored folder
    //                   inside one window)
    .option("--workspace <name>", "target the active tab in a named workspace window (works at top level too)")
    .option("--group <name>",     "target the active tab in a named tab-group (works at top level too)")
    //   --profile   P targets a connected Chrome PROFILE (parent scope —
    //                   composes with the three above). One profile
    //                   connected: never needed. Two+: unscoped commands
    //                   fail profile_ambiguous instead of guessing.
    .option("--profile <name>",   "target a connected Chrome profile by label or instanceId prefix (works at top level too)")
    .enablePositionalOptions()
    .addHelpText(
      "after",
      `

The core loop:
  chrome-relay tabs
  chrome-relay navigate "https://chrome-relay.kushalsm.com" --new      # background tab
  chrome-relay snapshot --tab <tabId> -i                 # actionable elements get @refs
  chrome-relay click @e12                                # act on a ref, no --tab needed
  chrome-relay fill @e14 "value"
  chrome-relay snapshot --tab <tabId> -i                 # re-look after the page changes

Also:
  chrome-relay wait --tab <tabId> --text "Welcome"       # selector/@ref/text/url/load/fn
  chrome-relay get text @e12                             # one value, no full snapshot
  chrome-relay keys --tab <tabId> Enter
  chrome-relay js --tab <tabId> "return document.title"
  chrome-relay screenshot --tab <tabId> -o evidence.png
  chrome-relay skills get core                           # the agent playbook, version-matched

Notes:
  Refs come from snapshot and carry their own tab. Tools attach via CDP and
  run on backgrounded tabs without stealing focus. Errors are structured.
  Branch on relayError.code (stale_ref means: re-run snapshot).

How one CLI reaches many browsers/profiles:
  Every browser profile running the extension spawns its OWN native host
  (native messaging is 1:1) on its own local port, registered in
  ~/.chrome-relay/instances/. Each CLI call discovers the registry, picks
  exactly ONE host, and sends the command to it — there is no shared daemon.
  One profile connected: nothing to think about. Several (across Chrome,
  Dia, Arc, ... alike): scope with --profile <label|idprefix>, or use a
  qualified ref (@3f2a:e12) which routes by itself; unscoped commands fail
  with profile_ambiguous rather than guess. \`chrome-relay profile list\`
  shows what's connected; every result names the profile that served it.
`
    );

  // Build the context every per-domain module needs. baseArgs closes over
  // the program instance so it can read program-level (parent) flags.
  // withBase is a one-call combiner: `withBase(opts, { foo: 1 })` =
  // `{ ...baseArgs(opts), foo: 1 }` so command actions stop repeating
  // the `Object.assign(args, baseArgs(opts))` boilerplate.
  // Program-level --profile must scope EVERY command, including ones with
  // no target flags (`tabs`). baseArgs covers the flagged ones; this source
  // is the fallback the call layer consults for the rest.
  setDefaultProfileSource(() => (program.opts() as { profile?: string }).profile);

  const baseArgs = makeBaseArgs(program);
  const ctx: CommandContext = {
    program,
    baseArgs,
    withBase: makeWithBase(baseArgs),
    run: runTool
  };

  // install-update doesn't need ctx. Its commands don't target a tab.
  registerInstallUpdate(program);
  registerNavigation(ctx);
  registerInput(ctx);
  registerCapture(ctx);
  registerSessions(ctx);
  registerLoop(ctx);
  registerProfile(ctx);
  registerUpload(ctx);

  return program;
}
