// tabs / navigate / switch / close / call — the tab-lifecycle and raw
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
      .option("--active", "activate the tab after navigating (default: background — no focus theft)")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay navigate "https://example.com"                    # navigate current tab
  chrome-relay navigate --tab 123 "https://example.com"          # navigate an existing tab
  chrome-relay navigate "https://example.com" --new              # open in a new background tab
  chrome-relay navigate "https://example.com" --new --active     # open new tab AND show it to the user

By default chrome-relay never steals focus — navigated tabs (new or
existing) stay in whatever state they're in. Pass --active when you
actually want the user looking at the page.
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

    const extras: Record<string, unknown> = { url };
    if (opts.new) extras.newTab = true;
    // 0.5.20: background is the default. Agent opts into focus via --active.
    if (opts.active) extras.active = true;
    await run("chrome_navigate", withBase(opts, extras));
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
