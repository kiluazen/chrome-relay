// tabs / navigate / switch / close / call — the tab-lifecycle and raw
// pass-through commands.

import { tabOpt, type CommandContext } from "./shared.js";

export function registerNavigation(ctx: CommandContext): void {
  const { program, baseArgs, run } = ctx;

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
      .option("--inactive", "do not activate the tab")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay navigate "https://example.com"
  chrome-relay navigate --tab 123456789 "https://example.com"
  chrome-relay navigate "https://example.com" --new --inactive
`
      )
  ).action(async (url: string, opts) => {
    if (/^\d+$/.test(url)) {
      process.stderr.write(
        `navigate expects a URL, but "${url}" looks like a tab ID.\n` +
          `Use "chrome-relay switch ${url}" to activate that tab, or ` +
          `"chrome-relay navigate --tab ${url} https://example.com" to navigate it.\n`
      );
      process.exit(1);
    }

    const args: Record<string, unknown> = { url };
    Object.assign(args, baseArgs(opts));
    if (opts.new) args.newTab = true;
    if (opts.inactive) args.active = false;
    await run("chrome_navigate", args);
  });

  program
    .command("switch <tabId>")
    .description("Activate a tab by ID.")
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
