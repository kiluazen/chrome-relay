// tabs / navigate / switch / close / call: the tab-lifecycle and raw
// pass-through commands.

import { snapshotOpt, tabOpt, type CommandContext } from "./shared.js";

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

  snapshotOpt(tabOpt(
    program
      .command("navigate <url>")
      .description("Navigate a tab to a URL. Use --tab <id> to target an existing tab.")
      .option("--new", "open in a new tab")
      .option("--active", "unsupported: Chrome Relay operates in the background")
      .option(
        "--wait <state>",
        "return once the page reaches: domcontentloaded (default) | load | commit | none",
        "domcontentloaded"
      )
      .option("--timeout <ms>", "max wait for --wait (default 10000, capped 25000)", (v) => Number(v))
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay navigate "https://chrome-relay.kushalsm.com"                    # navigate current tab
  chrome-relay navigate --tab 123 "https://chrome-relay.kushalsm.com"          # navigate an existing tab
  chrome-relay navigate "https://chrome-relay.kushalsm.com" --new              # open in a new background tab
  chrome-relay navigate "https://chrome-relay.kushalsm.com" --new --wait load  # also wait for images/subresources
  chrome-relay navigate "https://chrome-relay.kushalsm.com" --new --snapshot   # open, then print the page's refs

Chrome Relay operates in the background. Use --tab to target an existing
tab without selecting it. --active is rejected before navigation.

navigate returns when the new document is usable (DOMContentLoaded), so the
next snapshot reads the page you asked for. The result reports ready,
readyState and waitedMs; a slow page returns ready:false instead of failing.
A network error page returns loadFailed:true. --wait none returns as soon
as Chrome accepts the navigation.
`
      )
  )).action(async (url: string, opts) => {
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
    const waitUntil = String(opts.wait);
    if (!["none", "commit", "domcontentloaded", "load"].includes(waitUntil)) {
      process.stderr.write(`--wait must be one of: domcontentloaded, load, commit, none (got "${waitUntil}").\n`);
      process.exit(1);
      return;
    }
    extras.waitUntil = waitUntil;
    if (typeof opts.timeout === "number" && Number.isFinite(opts.timeout)) extras.waitTimeoutMs = opts.timeout;
    await run("chrome_navigate", withBase(opts, extras), opts.snapshot ? { settle: false } : undefined);
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
