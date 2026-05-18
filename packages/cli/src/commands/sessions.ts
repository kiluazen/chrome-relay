// viewport / console / network / workspace / group / self-reload — session-
// and capture-buffer commands that share filter/limit options.

import type { Command } from "commander";
import {
  CONSOLE_BUFFER_MAX_ENTRIES,
  CONSOLE_BUFFER_MAX_BYTES,
  NETWORK_BUFFER_MAX_ENTRIES
} from "@chrome-relay/protocol";
import { tabOpt, type CommandContext } from "./shared.js";

// Inline KB so we can interpolate "256 KB" cleanly into help strings.
const CONSOLE_BUFFER_MAX_KB = Math.round(CONSOLE_BUFFER_MAX_BYTES / 1024);

function netFilterOpts(cmd: Command) {
  return cmd
    .option("--filter <substr>", "url substring filter")
    .option("--status <bucket>", "ok | redirect | client_error | server_error | failed")
    .option("--method <verb>",   "exact method, e.g. POST")
    .option("--limit <n>",       "cap response length", (v) => Number(v));
}

function netFilterArgs(opts: { filter?: string; status?: string; method?: string; limit?: number }) {
  const a: Record<string, unknown> = {};
  if (opts.filter) a.filter = opts.filter;
  if (opts.status) a.status = opts.status;
  if (opts.method) a.method = opts.method;
  if (typeof opts.limit === "number") a.limit = opts.limit;
  return a;
}

export function registerSessions(ctx: CommandContext): void {
  const { program, withBase, run } = ctx;

  // ---------- viewport (§2.2 — device-metrics emulation) ----------
  const viewport = program
    .command("viewport")
    .description("Emulate device viewport, DPR, mobile flag, touch, and user agent.")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay viewport preset iphone-14 --tab 123
  chrome-relay viewport preset desktop-1440 --tab 123
  chrome-relay viewport set --tab 123 --width 414 --height 896 --mobile --dpr 3
  chrome-relay viewport clear --tab 123
  chrome-relay viewport list

Notes:
  The override survives navigations within the tab but is wiped when the
  debugger detaches (e.g. another extension takes over). Closing the tab
  clears it. Re-run after detach if the page snaps back to its default size.
`
    );

  tabOpt(
    viewport
      .command("set")
      .description("Apply explicit viewport dimensions.")
      .requiredOption("--width <px>",  "viewport width in CSS pixels", (v) => Number(v))
      .requiredOption("--height <px>", "viewport height in CSS pixels", (v) => Number(v))
      .option("--dpr <ratio>", "device pixel ratio (1, 2, 3...)", (v) => Number(v))
      .option("--mobile", "set the mobile flag (affects meta viewport interpretation)")
      .option("--touch", "enable touch event emulation")
      .option("--user-agent <ua>", "override the User-Agent header")
  ).action(async (opts) => {
    const extras: Record<string, unknown> = { action: "set", width: opts.width, height: opts.height };
    if (opts.dpr !== undefined)  extras.dpr = opts.dpr;
    if (opts.mobile)             extras.mobile = true;
    if (opts.touch)              extras.hasTouch = true;
    if (opts.userAgent)          extras.userAgent = opts.userAgent;
    await run("chrome_viewport", withBase(opts, extras));
  });

  tabOpt(
    viewport
      .command("preset <name>")
      .description("Apply a named device preset (iphone-14, pixel-7, desktop-1440, etc).")
  ).action(async (name: string, opts) => {
    await run("chrome_viewport", withBase(opts, { action: "preset", name }));
  });

  tabOpt(
    viewport
      .command("clear")
      .description("Drop the viewport override and return the tab to its native size.")
  ).action(async (opts) => {
    await run("chrome_viewport", withBase(opts, { action: "clear" }));
  });

  viewport
    .command("list")
    .description("List available presets.")
    .action(async () => {
      await run("chrome_viewport", { action: "list" });
    });

  program
    .command("self-reload")
    .description("Restart the chrome-relay extension's service worker (picks up newly built code).")
    .action(async () => {
      await run("chrome_self_reload", {});
    });

  // ---------- workspace (named Chrome WINDOWS for parallel agent work) ----------
  // Pre-0.4.0 this was called `group`. Renamed because "group" collides with
  // Chrome's own tab-group UI primitive, which is now exposed separately
  // via the `group` subcommand below.
  const workspace = program
    .command("workspace")
    .description("Manage named Chrome windows so multiple agents can drive separate windows.")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay workspace create bidsmith-h01 --url https://reddit.com
  chrome-relay workspace list
  chrome-relay --workspace bidsmith-h01 navigate https://news.ycombinator.com
  chrome-relay --workspace bidsmith-h01 screenshot -o evidence.png
  chrome-relay workspace close bidsmith-h01

Notes:
  Hard lifecycle: if you manually close the workspace's window, the next
  --workspace operation fails loudly until you run \`workspace close\` +
  \`workspace create\` again.
  Precedence on a single command: --tab > --group > --workspace.
`
    );

  workspace
    .command("create <name>")
    .description("Open a new Chrome window and bind it to <name>.")
    .option("--url <url>", "initial URL (default about:blank)")
    .option("--label <label>", "human-readable description shown in popup/list")
    .action(async (name: string, opts) => {
      const args: Record<string, unknown> = { action: "create", name };
      if (opts.url)   args.url = opts.url;
      if (opts.label) args.label = opts.label;
      await run("chrome_workspace", args);
    });

  workspace
    .command("list")
    .description("List all known workspaces + whether their window is still alive.")
    .action(async () => {
      await run("chrome_workspace", { action: "list" });
    });

  workspace
    .command("close <name>")
    .description("Close the workspace's window (if alive) and remove the binding.")
    .action(async (name: string) => {
      await run("chrome_workspace", { action: "close", name });
    });

  // ---------- group (tab-GROUPS — Chrome's colored folder of tabs) ----------
  const group = program
    .command("group")
    .description("Manage Chrome tab-groups (the colored, collapsible folders inside one window).")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay group create research --tabs 123,456,789 --color cyan
  chrome-relay group list
  chrome-relay group add research --tabs 1011
  chrome-relay group remove --tabs 456
  chrome-relay --group research navigate https://news.ycombinator.com
  chrome-relay group close research

Notes:
  Tab-groups live inside ONE Chrome window. To open in a specific window,
  pass --workspace W on \`group create\` (we'll route the underlying
  chrome.tabs.group call there).
  \`--group X navigate --new\` opens the new tab into the group's window AND
  drops it inside the group.
  Auto-pruned when the group's last tab is ungrouped or its window closes.
  Colors: grey, blue, red, yellow, green, pink, purple, cyan, orange.
`
    );

  group
    .command("create <name>")
    .description("Group existing tabs into a new tab-group bound to <name>.")
    .requiredOption("--tabs <ids>", "comma-separated tab IDs to group, e.g. 123,456,789")
    .option("--color <color>", "grey | blue | red | yellow | green | pink | purple | cyan | orange")
    .option("--collapsed", "create the group in its collapsed state")
    .action(async (name: string, opts) => {
      // Forward the raw comma-separated string. parseChromeGroupArgs
      // in @chrome-relay/protocol does strict per-element parsing —
      // doing it CLI-side would silently swallow bad IDs.
      const args: Record<string, unknown> = { action: "create", name, tabIds: String(opts.tabs) };
      if (opts.color)     args.color = opts.color;
      if (opts.collapsed) args.collapsed = true;
      await run("chrome_group", args);
    });

  group
    .command("list")
    .description("List all known tab-groups + their window/color/tabCount.")
    .action(async () => {
      await run("chrome_group", { action: "list" });
    });

  group
    .command("close <name>")
    .description("Ungroup the tabs in <name> and remove the binding.")
    .action(async (name: string) => {
      await run("chrome_group", { action: "close", name });
    });

  group
    .command("add <name>")
    .description("Add existing tabs to an existing tab-group.")
    .requiredOption("--tabs <ids>", "comma-separated tab IDs to add")
    .action(async (name: string, opts) => {
      // Raw string forwarded; protocol parser handles per-element strict parsing.
      await run("chrome_group", { action: "add", name, tabIds: String(opts.tabs) });
    });

  group
    .command("remove")
    .description("Ungroup specific tabs (they remain open, just outside any tab-group).")
    .requiredOption("--tabs <ids>", "comma-separated tab IDs to ungroup")
    .action(async (opts) => {
      // Raw string forwarded; protocol parser handles per-element strict parsing.
      await run("chrome_group", { action: "remove", tabIds: String(opts.tabs) });
    });

  // ---------- network (§2.7a — HTTP capture + HAR export) ----------
  // Filter / status / method / limit are lifted to the parent so they work
  // with `chrome-relay network --filter X` AND `network read --filter X`.
  const network = tabOpt(netFilterOpts(
    program
      .command("network")
      .description(`Capture HTTP request/response metadata. Ring buffer, last ${NETWORK_BUFFER_MAX_ENTRIES} per tab.`)
  ))
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay network --tab 123                              # last ${NETWORK_BUFFER_MAX_ENTRIES} requests
  chrome-relay network --tab 123 --filter api.example.com      # url substring
  chrome-relay network --tab 123 --status failed
  chrome-relay network --tab 123 --method POST
  chrome-relay network body <requestId> --tab 123              # lazy body fetch
  chrome-relay network har --tab 123 > capture.har             # HAR (metadata only)
  chrome-relay network har --tab 123 --with-bodies > full.har  # HAR with bodies
  chrome-relay network clear --tab 123

Privacy:
  Capturing network traffic includes Authorization headers, cookies, and
  request/response bodies. The capture stays in the extension's memory and
  is wiped on tab close. Don't run this on a tab whose state you wouldn't
  share with the agent invoking chrome-relay.

Notes:
  Bodies are NOT eagerly buffered — Chrome GCs response bodies ~30s after
  the request finishes. Use \`--body <id>\` or \`har --with-bodies\` promptly.
  WebSocket frames and SSE streams are out of scope.
`
    )
    .action(async (opts) => {
      await run("chrome_network", withBase(opts, netFilterArgs(opts)));
    });

  tabOpt(netFilterOpts(
    network.command("read").description("(alias) list captured network entries.")
  )).action(async (opts) => {
    await run("chrome_network", withBase(opts, netFilterArgs(opts)));
  });

  tabOpt(
    network
      .command("body <requestId>")
      .description("Fetch the response body for one request (lazy; may fail if GC'd).")
      .option("--head <bytes>", "truncate to first N bytes", (v) => Number(v))
      .option("--full",         "return the full body — default truncates to 8 KB")
  ).action(async (requestId: string, opts) => {
    const extras: Record<string, unknown> = { action: "body", requestId };
    if (opts.full) extras.full = true;
    if (typeof opts.head === "number") extras.head = opts.head;
    await run("chrome_network", withBase(opts, extras));
  });

  tabOpt(netFilterOpts(
    network
      .command("har")
      .description("Emit HAR-compatible JSON for the captured entries.")
      .option("--with-bodies", "fetch response bodies before emitting; strict by default — fails if any body cannot be fetched")
      .option("--best-effort-bodies", "with --with-bodies: keep the HAR even when some bodies are missing/errored (legacy behavior); per-entry _chrome_relay.bodyState/bodyError records what failed")
  )).action(async (opts) => {
    const extras: Record<string, unknown> = { ...netFilterArgs(opts), action: "har" };
    if (opts.withBodies) extras.withBodies = true;
    if (opts.bestEffortBodies) extras.bestEffortBodies = true;
    if (!opts.withBodies) {
      process.stderr.write(
        "[chrome-relay] HAR exported WITHOUT response bodies. Pass --with-bodies to include them " +
          "(strict by default; add --best-effort-bodies to allow per-entry misses).\n"
      );
    }
    await run("chrome_network", withBase(opts, extras));
  });

  tabOpt(
    network
      .command("clear")
      .description("Wipe the network buffer for this tab.")
  ).action(async (opts) => {
    await run("chrome_network", withBase(opts, { action: "clear" }));
  });

  // ---------- console (§2.7c — page console + exception capture) ----------
  tabOpt(
    program
      .command("console")
      .description(`Read console.log/warn/error + page exceptions (ring buffer, last ${CONSOLE_BUFFER_MAX_ENTRIES}).`)
      .option("--level <levels>", "comma-separated: log,info,warn,error,debug,exception")
      .option("--since <id>",     "only return entries with id > since (live-tail-ish)", (v) => Number(v))
      .option("--limit <n>",      "cap response length", (v) => Number(v))
      .option("--clear",          "wipe the buffer (no read)")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay console --tab 123
  chrome-relay console --tab 123 --level error,exception
  chrome-relay console --tab 123 --since 50         # entries newer than id 50 (tail-style polling)
  chrome-relay console --tab 123 --clear

Notes:
  Ring buffer holds the last ${CONSOLE_BUFFER_MAX_ENTRIES} entries per tab (or ${CONSOLE_BUFFER_MAX_KB} KB, whichever first).
  Wipes on tab close. First call on a tab subscribes; subsequent calls are
  instant in-memory reads.
`
      )
  ).action(async (opts) => {
    const extras: Record<string, unknown> = {};
    if (opts.clear)                extras.action = "clear";
    if (opts.level)                extras.levels = opts.level;
    if (typeof opts.since === "number") extras.since = opts.since;
    if (typeof opts.limit === "number") extras.limit = opts.limit;
    await run("chrome_console", withBase(opts, extras));
  });
}
