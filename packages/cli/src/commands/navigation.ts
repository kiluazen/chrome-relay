// tabs / navigate / switch / close / call: the tab-lifecycle and raw
// pass-through commands.

import { tabOpt, type CommandContext } from "./shared.js";

export function registerNavigation(ctx: CommandContext): void {
  const { program, withBase, run } = ctx;

  // `tabs` accepts an optional `list` verb for consistency with `group list`,
  // `viewport list`, `network read`, etc. Bare `tabs` and `tabs list` are
  // equivalent.
  program
    .command("tabs [verb]")
    .description("List open Chrome windows and tabs. (verb 'list' is accepted as alias)")
    .action(async (verb?: string) => {
      if (verb && verb !== "list") {
        process.stderr.write(`unknown tabs verb: ${verb}. Use 'tabs' or 'tabs list'.\n`);
        process.exit(1);
      }
      await run("get_windows_and_tabs", {});
    });

  tabOpt(
    program
      .command("navigate <url>")
      .description("Navigate a tab to a URL. Use --tab <id> to target an existing tab.")
      .option("--new", "open in a new tab")
      .option("--active", "unsupported: Chrome Relay operates in the background")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay navigate "https://chrome-relay.kushalsm.com"                    # navigate current tab
  chrome-relay navigate --tab 123 "https://chrome-relay.kushalsm.com"          # navigate an existing tab
  chrome-relay navigate "https://chrome-relay.kushalsm.com" --new              # open in a new background tab

Chrome Relay operates in the background. Use --tab to target an existing
tab without selecting it. --active is rejected before navigation.
`
      )
  ).action(async (url: string, opts) => {
    if (/^\d+$/.test(url)) {
      process.stderr.write(
        `navigate expects a URL, but "${url}" looks like a tab ID.\n` +
          `"chrome-relay navigate --tab ${url} https://chrome-relay.kushalsm.com" to navigate it.\n`
      );
      process.exit(1);
    }

    const extras: Record<string, unknown> = { url };
    if (opts.new) extras.newTab = true;
    // Keep legacy flag parsing so the shared validator explains the policy.
    if (opts.active) extras.active = true;
    await run("chrome_navigate", withBase(opts, extras));
  });

  program
    .command("switch <tabId>")
    .description("Unsupported: use --tab <id> on a command to work in the background.")
    .action(async (tabId: string) => {
      await run("chrome_switch_tab", { tabId: Number(tabId) });
    });

  program
    .command("close <tabIds...>")
    .description("Close one or more tabs by ID.")
    .action(async (tabIds: string[]) => {
      await run("chrome_close_tabs", { tabIds: tabIds.map(Number) });
    });

  program
    .command("call <tool> [json]")
    .description("Call any Chrome Relay tool with raw JSON args.")
    .action(async (tool: string, json?: string) => {
      const args = json ? JSON.parse(json) : {};
      await run(tool, args);
    });
}
