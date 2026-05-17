import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { CHROME_RELAY_VERSION } from "./index.js";
import { runDoctor, runInstall } from "./install/install.js";
import { callTool } from "./client/call.js";
import { listReleaseNotesSince } from "./release-notes.js";
import { tabOpt, makeBaseArgs, runTool } from "./commands/shared.js";

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

  // ---------- update + release-notes ----------
  // Agent-native versioning loop. `update` installs the latest CLI and then
  // re-execs the new binary with --since <oldVersion> so the printed bullets
  // come from the just-installed release-notes (single source of truth on
  // disk). `release-notes` is the queryable form — same data, no install.
  program
    .command("update")
    .description("Update chrome-relay CLI to the latest version and print what changed (agent-readable JSON).")
    .option("--dry-run", "skip the install; just show what changed since the current version")
    .action(async (opts: { dryRun?: boolean }) => {
      const fromVersion = CHROME_RELAY_VERSION;
      const { spawnSync } = await import("node:child_process");

      // Code-quality-hardening PR 5: return structured update metadata so
      // the agent can branch on whether the install was attempted, whether
      // it succeeded, and whether the re-exec proved the active binary
      // changed. "Install said success but binary didn't change" is a real
      // failure mode we surface explicitly.
      const out: {
        updatedFrom: string;
        updatedTo: string;
        install: {
          attempted: boolean;
          packageManager?: "pnpm" | "bun" | "npm";
          status?: number | null;
          command?: string;
        };
        binary: {
          path: string;
          reexeced: boolean;
        };
        releaseNotes: {
          source: "current_process" | "updated_binary";
          changes: ReturnType<typeof listReleaseNotesSince>;
        };
        warnings: Array<{ code: string; message: string }>;
      } = {
        updatedFrom: fromVersion,
        updatedTo: fromVersion,
        install: { attempted: false },
        binary: { path: process.argv[1] ?? "", reexeced: false },
        releaseNotes: { source: "current_process", changes: [] },
        warnings: []
      };

      if (!opts.dryRun) {
        const argv0 = process.argv[1] ?? "";
        const pm: "pnpm" | "bun" | "npm" =
          /[\\/](pnpm|\.pnpm)[\\/]/.test(argv0) ? "pnpm" :
          /[\\/]bun[\\/]/.test(argv0)            ? "bun" :
          "npm";
        const cmd: [string, string[]] =
          pm === "pnpm" ? ["pnpm", ["add", "-g", "chrome-relay@latest"]] :
          pm === "bun"  ? ["bun",  ["add", "-g", "chrome-relay@latest"]] :
                          ["npm",  ["install", "-g", "chrome-relay@latest"]];
        out.install = {
          attempted: true,
          packageManager: pm,
          command: `${cmd[0]} ${cmd[1].join(" ")}`
        };
        process.stderr.write(`[chrome-relay] updating from ${fromVersion} via ${pm}...\n`);
        const install = spawnSync(cmd[0], cmd[1], { stdio: "inherit" });
        out.install.status = install.status;
        if (install.status !== 0) {
          process.stderr.write(`[chrome-relay] install failed (${pm} exited ${install.status}). Try manually: ${cmd[0]} ${cmd[1].join(" ")}\n`);
          out.warnings.push({
            code: "update_install_failed",
            message: `Package-manager exit ${install.status}. Active binary unchanged.`
          });
          process.stdout.write(JSON.stringify(out, null, 2) + "\n");
          process.exit(1);
        }

        // Re-exec the just-installed binary and ask it for its version.
        // Three signals we can derive:
        //   1. `which chrome-relay` returns a path — usually the new binary.
        //   2. running that binary with --version prints something > fromVersion.
        //   3. that path differs from argv0 (cross-package-manager re-exec).
        // Any of these proves the active binary updated. If none, we warn.
        const which = spawnSync("which", ["chrome-relay"]);
        const newBin = which.stdout?.toString().trim();
        if (which.status === 0 && newBin) {
          const versionOut = spawnSync(newBin, ["--version"]);
          const newVersion = (versionOut.stdout?.toString() ?? "").trim();
          out.binary.path = newBin;
          if (newVersion && newVersion !== fromVersion) {
            out.updatedTo = newVersion;
            // Ask the new binary for the release notes since fromVersion.
            // Capture stdout so we can fold it into the structured response.
            const rn = spawnSync(newBin, ["release-notes", "--since", fromVersion]);
            try {
              const parsed = JSON.parse(rn.stdout?.toString() ?? "");
              if (Array.isArray(parsed.changes)) {
                out.releaseNotes = { source: "updated_binary", changes: parsed.changes };
              }
            } catch {
              out.warnings.push({
                code: "release_notes_parse_failed",
                message: `Could not parse output of "${newBin} release-notes --since ${fromVersion}".`
              });
            }
            out.binary.reexeced = true;
          } else {
            // Install said success, binary still at fromVersion. Could be
            // an environment mismatch (npm installed into a global bin
            // that's not first on PATH) or a stale shim.
            out.warnings.push({
              code: "update_not_verified",
              message: `Install completed but \`${newBin} --version\` still reports ${newVersion || "unknown"}. The active binary may not have changed — check your PATH or run "${cmd[0]} ${cmd[1].join(" ")}" manually and verify.`
            });
          }
        } else {
          out.warnings.push({
            code: "update_not_verified",
            message: `Install completed but \`which chrome-relay\` did not return a path. Could not verify the active binary changed.`
          });
        }
      }

      // Fall back to local release notes when we didn't successfully
      // re-exec the new binary. This is the dry-run path AND the
      // could-not-verify path.
      if (out.releaseNotes.source === "current_process") {
        out.releaseNotes.changes = listReleaseNotesSince(fromVersion);
      }
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    });

  program
    .command("release-notes")
    .description("Print release notes since a version (no install). JSON output for agents.")
    .option("--since <version>", "show release notes for versions newer than this", "0.0.0")
    .action((opts: { since: string }) => {
      const changes = listReleaseNotesSince(opts.since);
      process.stdout.write(JSON.stringify({
        currentVersion: CHROME_RELAY_VERSION,
        since: opts.since,
        changes
      }, null, 2) + "\n");
    });

  // Local alias so the rest of the file (lots of `run(...)` callsites)
  // doesn't need a sed pass. Behavior identical to runTool from shared.
  const run = runTool;

  // Build a curried baseArgs that closes over our program instance.
  // tabOpt + runTool are program-agnostic and imported directly.
  const baseArgs = makeBaseArgs(program);

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
    Object.assign(args, baseArgs(opts));
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
  // New in 0.4.0. Wraps chrome.tabs.group + chrome.tabGroups. Distinct from
  // `workspace`: groups live INSIDE one window and show up as a named,
  // colored, collapsible chip in the tab bar.
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
      const args: Record<string, unknown> = { action: "create", name };
      args.tabIds = String(opts.tabs).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
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
      const tabIds = String(opts.tabs).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
      await run("chrome_group", { action: "add", name, tabIds });
    });

  group
    .command("remove")
    .description("Ungroup specific tabs (they remain open, just outside any tab-group).")
    .requiredOption("--tabs <ids>", "comma-separated tab IDs to ungroup")
    .action(async (opts) => {
      const tabIds = String(opts.tabs).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
      await run("chrome_group", { action: "remove", tabIds });
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
      .option("--with-bodies", "fetch response bodies before emitting; strict by default — fails if any body cannot be fetched")
      .option("--best-effort-bodies", "with --with-bodies: keep the HAR even when some bodies are missing/errored (legacy behavior); per-entry _chrome_relay.bodyState/bodyError records what failed")
  )).action(async (opts) => {
    const args: Record<string, unknown> = { ...baseArgs(opts), ...netFilterArgs(opts), action: "har" };
    if (opts.withBodies) args.withBodies = true;
    if (opts.bestEffortBodies) args.bestEffortBodies = true;
    if (!opts.withBodies) {
      process.stderr.write(
        "[chrome-relay] HAR exported WITHOUT response bodies. Pass --with-bodies to include them " +
          "(strict by default; add --best-effort-bodies to allow per-entry misses).\n"
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
    const args: Record<string, unknown> = baseArgs(opts);
    if (opts.clear)                args.action = "clear";
    if (opts.level)                args.levels = opts.level;
    if (typeof opts.since === "number") args.since = opts.since;
    if (typeof opts.limit === "number") args.limit = opts.limit;
    await run("chrome_console", args);
  });

  // ---------- hover (Input.dispatchMouseEvent type=mouseMoved) ----------
  // Triggers :hover / :focus-within / hover-driven JS handlers WITHOUT
  // clicking. Pair with screencast to capture state changes.
  tabOpt(
    program
      .command("hover [selector]")
      .description("Move the pointer over an element or coordinates. Fires :hover styles.")
      .option("--x <px>", "explicit x coordinate (CSS pixels)", (v) => Number(v))
      .option("--y <px>", "explicit y coordinate (CSS pixels)", (v) => Number(v))
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay hover --tab 123 'button[title="Install runner"]'
  chrome-relay hover --tab 123 --x 1327 --y 771

Use before screencast to capture hover-driven micro-states (button glow,
tooltip appearance, etc.) that a bare click would skip past too quickly.
`
      )
  ).action(async (selector: string | undefined, opts) => {
    const args: Record<string, unknown> = {};
    Object.assign(args, baseArgs(opts));
    if (selector) args.selector = selector;
    if (typeof opts.x === "number" && typeof opts.y === "number") {
      args.x = opts.x;
      args.y = opts.y;
    }
    await run("chrome_hover", args);
  });

  // ---------- screencast (Page.startScreencast / stopScreencast) ----------
  // Paint-driven JPEG frame capture. Catches CSS transitions, fade-ins,
  // hover tooltips — everything Page.captureScreenshot polling misses.
  // REQUIRES an active tab (Chrome doesn't paint backgrounded tabs).
  // CLI shape: start → returns immediately, stop → returns frames JSON or
  // writes them to disk + invokes ffmpeg if --out is given. Stop runs a
  // SHA-256 dedupe pass by default; pass --no-dedupe to keep raw frames.
  // See docs/recording.md.
  const screencast = program
    .command("screencast")
    .description("Record a tab via CDP (paint-driven). Requires an active tab.")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay screencast start --tab 123 --quality 80 --max-width 900
  # ... drive the interaction (hover, click, etc.) ...
  chrome-relay screencast stop --tab 123 --out /tmp/recording

  # The --out path becomes a directory of frame_NNNN.jpg files. If ffmpeg
  # is on PATH and --gif is also passed, an animated GIF is written next to
  # the frames at /tmp/recording.gif.

Notes:
  Frames buffer in the extension service worker. A 10-second capture at
  default settings (jpeg q=60, ~15fps, full viewport) lands ~2-3 MB.
  Pass --max-width to downscale and lighten the buffer.
  Each frame is base64 JPEG; the CLI decodes them when --out is given.
`
    );

  tabOpt(
    screencast
      .command("start")
      .description("Begin screencast capture on a tab.")
      .option("--format <fmt>", "jpeg | png (default jpeg)")
      .option("--quality <n>",  "jpeg quality 0-100 (default 80)", (v) => Number(v))
      .option("--max-width <px>",  "downscale; aspect preserved", (v) => Number(v))
      .option("--max-height <px>", "downscale; aspect preserved", (v) => Number(v))
      .option("--every-nth <n>",   "throttle: keep 1 in N frames (default 1)", (v) => Number(v))
  ).action(async (opts) => {
    const args: Record<string, unknown> = { action: "start" };
    Object.assign(args, baseArgs(opts));
    if (opts.format)                       args.format = opts.format;
    if (typeof opts.quality === "number")  args.quality = opts.quality;
    if (typeof opts.maxWidth === "number") args.maxWidth = opts.maxWidth;
    if (typeof opts.maxHeight === "number") args.maxHeight = opts.maxHeight;
    if (typeof opts.everyNth === "number") args.everyNthFrame = opts.everyNth;
    await run("chrome_screencast", args);
  });

  tabOpt(
    screencast
      .command("stop")
      .description("Stop the screencast and emit frames (or write to disk).")
      .option("-o, --out <dir>", "write frames as JPEGs into this directory (created if missing)")
      .option("--gif",            "after writing frames, ffmpeg them into <dir>.gif")
      .option("--mp4",            "after writing frames, ffmpeg them into <dir>.mp4")
      .option("--fps <n>",        "assumed framerate when invoking ffmpeg (default 15)", (v) => Number(v))
      .option("--no-dedupe",      "keep raw frames; default collapses consecutive identical frames via SHA-256")
  ).action(async (opts) => {
    const args: Record<string, unknown> = { action: "stop" };
    Object.assign(args, baseArgs(opts));
    try {
      const result = await callTool("chrome_screencast", args) as {
        frameCount: number;
        durationMs: number;
        frames: Array<{ data: string; timestamp: number; width: number; height: number }>;
      };
      if (!opts.out) {
        // Without --out, just print a summary; dumping raw base64 frames to
        // stdout would flood the terminal.
        const { frames, ...summary } = result;
        process.stdout.write(JSON.stringify({ ...summary, framesOmitted: frames.length, hint: "pass --out <dir> to save" }, null, 2) + "\n");
        return;
      }
      const { mkdirSync, writeFileSync, renameSync, unlinkSync } = await import("node:fs");
      const path = await import("node:path");
      const { createHash } = await import("node:crypto");
      mkdirSync(opts.out, { recursive: true });
      result.frames.forEach((f, i) => {
        const name = `frame_${String(i + 1).padStart(4, "0")}.jpg`;
        writeFileSync(path.join(opts.out, name), Buffer.from(f.data, "base64"));
      });
      process.stdout.write(`Wrote ${result.frames.length} frames to ${opts.out}\n`);

      // Dedupe: SHA-256 each frame, drop those whose hash matches the
      // previous one, renumber survivors so ffmpeg's image2 reader stays
      // happy. commander maps --no-dedupe to opts.dedupe === false.
      const dedupeOn = opts.dedupe !== false;
      if (dedupeOn && result.frames.length > 1) {
        const hashes = result.frames.map((f) =>
          createHash("sha256").update(Buffer.from(f.data, "base64")).digest("hex")
        );
        const kept: number[] = [];
        let prev = "";
        hashes.forEach((h, i) => {
          if (h !== prev) kept.push(i);
          prev = h;
        });
        const dropped = result.frames.length - kept.length;
        if (dropped > 0) {
          // Two-pass rename via .tmp suffix to avoid clobbering source files
          // mid-rename (frame_0002 → frame_0001 would overwrite the original).
          for (let i = 0; i < result.frames.length; i++) {
            const src = path.join(opts.out, `frame_${String(i + 1).padStart(4, "0")}.jpg`);
            try { unlinkSync(src); } catch { /* missing is fine */ }
          }
          kept.forEach((srcIdx, newIdx) => {
            const tmp = path.join(opts.out, `tmp_${String(newIdx + 1).padStart(4, "0")}.jpg`);
            writeFileSync(tmp, Buffer.from(result.frames[srcIdx].data, "base64"));
          });
          kept.forEach((_, newIdx) => {
            const tmp = path.join(opts.out, `tmp_${String(newIdx + 1).padStart(4, "0")}.jpg`);
            const final = path.join(opts.out, `frame_${String(newIdx + 1).padStart(4, "0")}.jpg`);
            renameSync(tmp, final);
          });
          process.stdout.write(`Deduped: dropped ${dropped} identical frames, ${kept.length} remain.\n`);
        } else {
          process.stdout.write(`Deduped: no consecutive duplicates found.\n`);
        }
      }

      if (opts.gif || opts.mp4) {
        const fps = typeof opts.fps === "number" ? opts.fps : 15;
        const { spawnSync } = await import("node:child_process");
        const which = spawnSync("which", ["ffmpeg"]);
        if (which.status !== 0) {
          process.stderr.write("[chrome-relay] ffmpeg not on PATH — skipping --gif/--mp4.\n");
          return;
        }
        if (opts.gif) {
          const gifOut = `${opts.out.replace(/\/$/, "")}.gif`;
          const r = spawnSync("ffmpeg", [
            "-y", "-framerate", String(fps),
            "-i", path.join(opts.out, "frame_%04d.jpg"),
            "-vf", `fps=${fps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
            "-loop", "0",
            gifOut
          ], { stdio: "inherit" });
          if (r.status === 0) process.stdout.write(`Wrote ${gifOut}\n`);
        }
        if (opts.mp4) {
          const mp4Out = `${opts.out.replace(/\/$/, "")}.mp4`;
          const r = spawnSync("ffmpeg", [
            "-y", "-framerate", String(fps),
            "-i", path.join(opts.out, "frame_%04d.jpg"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
            mp4Out
          ], { stdio: "inherit" });
          if (r.status === 0) process.stdout.write(`Wrote ${mp4Out}\n`);
        }
      }
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.message : String(error)) + "\n"
      );
      process.exit(1);
    }
  });

  return program;
}
