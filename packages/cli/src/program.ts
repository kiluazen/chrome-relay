// CLI entry point — just builds the Command tree by registering each
// per-domain module. The actual command bodies live in commands/*.ts.
//
// Code-quality-hardening PR 7 (file split): until 0.5.8 every command was
// inline in this file (1041 lines). The doc's "split program.ts" PR is
// here: each domain gets a register() that owns its commands, this file
// is the assembly.

import { Command } from "commander";
import { CHROME_RELAY_VERSION } from "./index.js";
import { makeBaseArgs, runTool, type CommandContext } from "./commands/shared.js";
import { registerInstallUpdate } from "./commands/install-update.js";
import { registerNavigation } from "./commands/navigation.js";
import { registerInput } from "./commands/input.js";
import { registerCapture } from "./commands/capture.js";
import { registerSessions } from "./commands/sessions.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("chrome-relay")
    .description("Connect your local Chrome browser to coding agents through a local bridge.")
    .version(CHROME_RELAY_VERSION)
    .showHelpAfterError()
    // Global --workspace and --group flags: usable at the top level
    // (`chrome-relay --workspace W <cmd> ...`) or on the subcommand itself
    // (`chrome-relay <cmd> --workspace W ...`). Subcommands resolve the
    // effective value via baseArgs() which checks subcommand-level first,
    // then falls back to the program-level (parent) option.
    //
    //   --workspace W → target a named Chrome WINDOW (own taskbar entry)
    //   --group     G → target a named tab-GROUP (Chrome's colored folder
    //                   inside one window)
    .option("--workspace <name>", "target the active tab in a named workspace window (works at top level too)")
    .option("--group <name>",     "target the active tab in a named tab-group (works at top level too)")
    .enablePositionalOptions()
    .addHelpText(
      "after",
      `

Common agent flow:
  chrome-relay tabs
  chrome-relay navigate --tab <tabId> "https://example.com"
  chrome-relay read --tab <tabId> -i
  chrome-relay click --tab <tabId> "<selector>"
  chrome-relay fill --tab <tabId> "<selector>" "value"
  chrome-relay type --tab <tabId> -s "<selector>" "text into rich editor"
  chrome-relay keys --tab <tabId> Enter
  chrome-relay js --tab <tabId> "return document.title"
  chrome-relay screenshot --tab <tabId> -o evidence.png

Notes:
  navigate takes a URL. Use --tab to target an existing tab.
  Tools attach via CDP and run on backgrounded tabs without stealing focus.
`
    );

  // Build the context every per-domain module needs. baseArgs closes over
  // the program instance so it can read program-level (parent) flags.
  const ctx: CommandContext = {
    program,
    baseArgs: makeBaseArgs(program),
    run: runTool
  };

  // install-update doesn't need ctx — its commands don't target a tab.
  registerInstallUpdate(program);
  registerNavigation(ctx);
  registerInput(ctx);
  registerCapture(ctx);
  registerSessions(ctx);

  return program;
}
