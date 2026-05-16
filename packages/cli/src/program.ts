import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { CHROME_RELAY_VERSION } from "./index.js";
import { runDoctor, runInstall } from "./install/install.js";
import { callTool } from "./client/call.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("chrome-relay")
    .description("Connect your local Chrome browser to coding agents through a local bridge.")
    .version(CHROME_RELAY_VERSION)
    .showHelpAfterError()
    // Global --group flag: `chrome-relay --group X navigate ...` and
    // `chrome-relay navigate --group X ...` both work. Subcommands resolve
    // the effective value via baseArgs() which checks subcommand-level first,
    // then falls back to the program-level (parent) option.
    .option("--group <name>", "target the active tab of a named group window (works at top level too)")
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

  program
    .command("install")
    .description("Install and register the local Chrome Relay host.")
    .action(async () => {
      await runInstall();
    });

  program
    .command("doctor")
    .description("Validate the local Chrome Relay installation.")
    .action(async () => {
      const ok = await runDoctor();
      process.exit(ok ? 0 : 1);
    });

  async function run(name: string, args: Record<string, unknown>): Promise<void> {
    try {
      const result = await callTool(name, args);
      if (typeof result === "string") {
        process.stdout.write(result + "\n");
      } else {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      }
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.message : String(error)) + "\n"
      );
      process.exit(1);
    }
  }

  function tabOpt(cmd: Command) {
    return cmd
      .option("-t, --tab <id>", "target tab ID", (v) => Number(v))
      .option("--group <name>", "target the active tab of a named group window (see `chrome-relay group`)");
  }

  // Build a base args object from common options. Every subcommand that
  // takes a tab/group routes through here so the `--tab wins, --group
  // fallback` contract stays in one place.
  //
  // Group precedence: subcommand-level --group wins over program-level
  // (parent) --group. Lets `chrome-relay --group default <cmd> --group override`
  // do the right thing for ad-hoc one-offs in a session.
  function baseArgs(opts: { tab?: number; group?: string }): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (opts.tab !== undefined)  args.tabId = opts.tab;
    const effectiveGroup = opts.group ?? (program.opts() as { group?: string }).group;
    if (effectiveGroup)          args.groupName = effectiveGroup;
    return args;
  }

  // `tabs` accepts an optional `list` verb for consistency with `group list`,
  // `viewport list`, `network read`, etc. Bare `tabs` and `tabs list` are
  // equivalent. Anything else after `tabs` is a positional we don't expect
  // and Commander will reject it.
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

  tabOpt(
    program
      .command("screenshot")
      .description("Capture a screenshot of any tab without activating it.")
      .option("--full", "capture beyond the viewport (full page)")
      .option("--bbox <rect>", "capture a region: 'x,y,width,height' (pixels)")
      .option("--selector <css>", "capture the bounding box of a CSS selector")
      .option("--padding <px>", "pixels of padding around --selector region", (v) => Number(v))
      .option("--max-edge <px>", "downscale so longer edge ≤ this many pixels (no default; opt-in)", (v) => Number(v))
      .option("-o, --out <path>", "save image to path (base64 PNG decoded)")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay screenshot -o active-tab.png
  chrome-relay screenshot --tab 123456789 -o evidence.png
  chrome-relay screenshot --tab 123456789 --full -o full-page.png
  chrome-relay screenshot --tab 123456789 --bbox 0,0,1280,80 -o header.png
  chrome-relay screenshot --tab 123456789 --selector "header" -o header.png
  chrome-relay screenshot --tab 123456789 --selector ".card:nth-child(3)" --padding 8 -o card.png

Region screenshots (--bbox / --selector) are ~10x cheaper in tokens than a
full-tab screenshot when an agent only needs to see one component.
`
      )
  ).action(async (opts) => {
    const args: Record<string, unknown> = {};
    Object.assign(args, baseArgs(opts));
    if (opts.full) args.fullPage = true;
    if (opts.bbox) args.bbox = opts.bbox;
    if (opts.selector) args.selector = opts.selector;
    if (typeof opts.padding === "number") args.padding = opts.padding;
    if (typeof opts.maxEdge === "number") args.maxEdge = opts.maxEdge;
    try {
      const result = await callTool("chrome_screenshot", args);
      if (opts.out && result && typeof result === "object") {
        const data = (result as { dataUrl?: string; data?: string }).dataUrl
          ?? (result as { data?: string }).data;
        if (typeof data === "string") {
          const b64 = data.includes(",") ? data.split(",")[1] : data;
          writeFileSync(opts.out, Buffer.from(b64, "base64"));
          process.stdout.write(`Saved screenshot to ${opts.out}\n`);
          return;
        }
      }
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.message : String(error)) + "\n"
      );
      process.exit(1);
    }
  });

  tabOpt(
    program
      .command("read")
      .description("Extract page structure and interactive elements.")
      .option("-i, --interactive", "return only interactive elements")
  ).action(async (opts) => {
    const args: Record<string, unknown> = {};
    Object.assign(args, baseArgs(opts));
    if (opts.interactive) args.interactiveOnly = true;
    await run("chrome_read_page", args);
  });

  tabOpt(
    program.command("click <selector>").description("Click an element by CSS selector.")
  ).action(async (selector: string, opts) => {
    const args: Record<string, unknown> = { selector };
    Object.assign(args, baseArgs(opts));
    await run("chrome_click_element", args);
  });

  tabOpt(
    program
      .command("fill <selector> <value>")
      .description("Fill an input or textarea.")
  ).action(async (selector: string, value: string, opts) => {
    const args: Record<string, unknown> = { selector, value };
    Object.assign(args, baseArgs(opts));
    await run("chrome_fill_or_select", args);
  });

  tabOpt(
    program
      .command("keys <keys>")
      .description("Press a single key or chord via trusted CDP input (e.g. Enter, Cmd+K).")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay keys Enter
  chrome-relay keys Tab
  chrome-relay keys Cmd+K
  chrome-relay keys Shift+ArrowDown

For typing text into a field, use \`chrome-relay type\` instead.
`
      )
  ).action(async (keys: string, opts) => {
    const args: Record<string, unknown> = { keys };
    Object.assign(args, baseArgs(opts));
    await run("chrome_keyboard", args);
  });

  tabOpt(
    program
      .command("type <text>")
      .description("Insert text via trusted CDP input. Works in contenteditable / Draft.js / Lexical.")
      .option("-s, --selector <selector>", "focus this element first")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay type --selector "[data-testid=tweetTextarea_0]" "hello world"
  chrome-relay type "appended into already-focused element"

When to pick which:
  fill   — plain <input>, <textarea>, <select>, React-controlled inputs (atomic write).
  type   — contenteditable, Draft.js, Lexical, ProseMirror (trusted text commit).
  keys   — Enter, Tab, Esc, arrows, modifier chords (single key press).
  js     — anything else.
`
      )
  ).action(async (text: string, opts) => {
    const args: Record<string, unknown> = { text };
    Object.assign(args, baseArgs(opts));
    if (opts.selector) args.selector = opts.selector;
    await run("chrome_type", args);
  });

  tabOpt(
    program
      .command("js <code>")
      .description("Evaluate JavaScript in the page MAIN world. Use `return` for the value.")
      .option("--timeout-ms <ms>", "execution timeout in milliseconds (default 15000)", (v) => Number(v))
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay js "return document.title"
  chrome-relay js "return await fetch('/api/me').then(r => r.json())"
  chrome-relay js --tab 12345 "return document.querySelectorAll('article').length"

Notes:
  Code is wrapped in an async IIFE. Top-level await works. Use \`return\` to send a value back.
  Returned value is JSON-serialized. DOM nodes and functions become {}.
  Runs in MAIN world: page globals, framework internals, and shadow roots are reachable.
`
      )
  ).action(async (code: string, opts) => {
    const args: Record<string, unknown> = { code };
    Object.assign(args, baseArgs(opts));
    if (typeof opts.timeoutMs === "number") args.timeoutMs = opts.timeoutMs;
    await run("chrome_evaluate", args);
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
    const args: Record<string, unknown> = { action: "set", width: opts.width, height: opts.height };
    if (opts.tab !== undefined)  args.tabId = opts.tab;
    if (opts.dpr !== undefined)  args.dpr = opts.dpr;
    if (opts.mobile)             args.mobile = true;
    if (opts.touch)              args.hasTouch = true;
    if (opts.userAgent)          args.userAgent = opts.userAgent;
    await run("chrome_viewport", args);
  });

  tabOpt(
    viewport
      .command("preset <name>")
      .description("Apply a named device preset (iphone-14, pixel-7, desktop-1440, etc).")
  ).action(async (name: string, opts) => {
    const args: Record<string, unknown> = { action: "preset", name };
    Object.assign(args, baseArgs(opts));
    await run("chrome_viewport", args);
  });

  tabOpt(
    viewport
      .command("clear")
      .description("Drop the viewport override and return the tab to its native size.")
  ).action(async (opts) => {
    const args: Record<string, unknown> = { action: "clear" };
    Object.assign(args, baseArgs(opts));
    await run("chrome_viewport", args);
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

  // ---------- ax (§2.4 — accessibility tree) ----------
  tabOpt(
    program
      .command("ax")
      .description("Extract the accessibility tree — ~30× smaller than `read` and more semantic.")
      .option("-i, --interactive-only", "filter to actionable roles (button, link, textbox, ...)")
      .option("--root <role>",           "start from the first node matching this role (e.g. 'main')")
      .option("--include-subframes",     "walk subframes too (default: top frame only)")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay ax --tab 123
  chrome-relay ax --tab 123 --interactive-only
  chrome-relay ax --tab 123 --root main --interactive-only

Notes:
  Each node carries an "id" — that's the backendDOMNodeId. Pass it to
  \`chrome-relay click-ax --node <id>\` to click without a CSS selector.
`
      )
  ).action(async (opts) => {
    const args: Record<string, unknown> = baseArgs(opts);
    if (opts.interactiveOnly)  args.interactiveOnly = true;
    if (opts.root)             args.rootRole = opts.root;
    if (opts.includeSubframes) args.includeSubframes = true;
    await run("chrome_ax", args);
  });

  tabOpt(
    program
      .command("click-ax")
      .description("Click an element by its backendDOMNodeId from a previous `ax` call.")
      .requiredOption("--node <id>", "backendDOMNodeId from `chrome-relay ax`", (v) => Number(v))
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay click-ax --tab 123 --node 456

Notes:
  Throws explicitly if the node id is stale (page mutated since you called
  \`ax\`). Re-run \`ax\` and pass the fresh id.
`
      )
  ).action(async (opts) => {
    const args: Record<string, unknown> = baseArgs(opts);
    args.node = opts.node;
    await run("chrome_click_ax", args);
  });

  // ---------- group (§2.1 — named Chrome windows for parallel agent work) ----------
  const group = program
    .command("group")
    .description("Manage named Chrome windows so multiple agents can drive separate windows.")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay group create bidsmith-h01 --url https://reddit.com
  chrome-relay group list
  chrome-relay --group bidsmith-h01 navigate https://news.ycombinator.com
  chrome-relay --group bidsmith-h01 screenshot -o evidence.png
  chrome-relay group close bidsmith-h01

Notes:
  Hard lifecycle: if you manually close the group's window, the next
  --group operation fails loudly until you run \`group close\` + \`group create\` again.
  If you pass both --tab and --group on the same command, --tab wins.
`
    );

  group
    .command("create <name>")
    .description("Open a new Chrome window and bind it to <name>.")
    .option("--url <url>", "initial URL (default about:blank)")
    .option("--label <label>", "human-readable description shown in popup/list")
    .action(async (name: string, opts) => {
      const args: Record<string, unknown> = { action: "create", name };
      if (opts.url)   args.url = opts.url;
      if (opts.label) args.label = opts.label;
      await run("chrome_group", args);
    });

  group
    .command("list")
    .description("List all known groups + whether their window is still alive.")
    .action(async () => {
      await run("chrome_group", { action: "list" });
    });

  group
    .command("close <name>")
    .description("Close the group's window (if alive) and remove the binding.")
    .action(async (name: string) => {
      await run("chrome_group", { action: "close", name });
    });

  // ---------- network (§2.7a — HTTP capture + HAR export) ----------
  // Filter / status / method / limit are lifted to the parent so they work
  // with `chrome-relay network --filter X` AND `network read --filter X`.
  // Issue #6 was that they only worked on the explicit `read` subcommand
  // while the help advertised them on the parent.
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

  const network = tabOpt(netFilterOpts(
    program
      .command("network")
      .description("Capture HTTP request/response metadata. Ring buffer, last 200 per tab.")
  ))
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay network --tab 123                              # last 200 requests
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
    // Default action: read. Triggered by `chrome-relay network --tab N [--filter X]`
    // because we don't declare an explicit `read` subcommand.
    .action(async (opts) => {
      const args: Record<string, unknown> = { ...baseArgs(opts), ...netFilterArgs(opts) };
      await run("chrome_network", args);
    });

  // `network read` as an explicit verb alias — same behavior as the parent's
  // default action. Kept for consistency with `group list` / `viewport list`.
  tabOpt(netFilterOpts(
    network.command("read").description("(alias) list captured network entries.")
  )).action(async (opts) => {
    const args: Record<string, unknown> = { ...baseArgs(opts), ...netFilterArgs(opts) };
    await run("chrome_network", args);
  });

  tabOpt(
    network
      .command("body <requestId>")
      .description("Fetch the response body for one request (lazy; may fail if GC'd).")
      .option("--head <bytes>", "truncate to first N bytes", (v) => Number(v))
      .option("--full",         "return the full body — default truncates to 8 KB")
  ).action(async (requestId: string, opts) => {
    const args: Record<string, unknown> = { ...baseArgs(opts), action: "body", requestId };
    if (opts.full) args.full = true;
    if (typeof opts.head === "number") args.head = opts.head;
    await run("chrome_network", args);
  });

  tabOpt(netFilterOpts(
    network
      .command("har")
      .description("Emit HAR-compatible JSON for the captured entries.")
      .option("--with-bodies", "fetch response bodies before emitting (best-effort; bodies GC'd by Chrome become null)")
  )).action(async (opts) => {
    const args: Record<string, unknown> = { ...baseArgs(opts), ...netFilterArgs(opts), action: "har" };
    if (opts.withBodies) args.withBodies = true;
    else {
      process.stderr.write(
        "[chrome-relay] HAR exported WITHOUT response bodies. Pass --with-bodies to include them " +
          "(best-effort; bodies older than ~30s may be unavailable).\n"
      );
    }
    await run("chrome_network", args);
  });

  tabOpt(
    network
      .command("clear")
      .description("Wipe the network buffer for this tab.")
  ).action(async (opts) => {
    const args: Record<string, unknown> = { ...baseArgs(opts), action: "clear" };
    await run("chrome_network", args);
  });

  // ---------- console (§2.7c — page console + exception capture) ----------
  tabOpt(
    program
      .command("console")
      .description("Read console.log/warn/error + page exceptions (ring buffer, last 200).")
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
  Ring buffer holds the last 200 entries per tab (or 256 KB, whichever first).
  Wipes on tab close. First call on a tab subscribes; subsequent calls are
  instant in-memory reads.
`
      )
  ).action(async (opts) => {
    const args: Record<string, unknown> = {};
    if (opts.tab !== undefined)    args.tabId = opts.tab;
    if (opts.clear)                args.action = "clear";
    if (opts.level)                args.levels = opts.level;
    if (typeof opts.since === "number") args.since = opts.since;
    if (typeof opts.limit === "number") args.limit = opts.limit;
    await run("chrome_console", args);
  });

  return program;
}
