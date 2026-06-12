// wait / get / batch / skills — loop-ergonomics commands (adoption-spec
// Changes 3, 5, 6, 7).

import { readFileSync } from "node:fs";
import {
  MAX_BATCH_BYTES,
  parseRefToken,
  RelayError,
  TOOL_NAMES
} from "@chrome-relay/protocol";
import { callTool } from "../client/call.js";
import { tabOpt, type CommandContext } from "./shared.js";

// Core agent guide — inlined at build time from the canonical skill
// (skills/chrome-relay/SKILL.md) via tsup's `define`, so the playbook the
// binary prints is always version-matched to the binary itself. The
// readFileSync fallback covers src-mode runs (vitest, ts-node) where the
// define isn't applied.
declare const __CHROME_RELAY_CORE_SKILL__: string;
function coreSkillText(): string {
  if (typeof __CHROME_RELAY_CORE_SKILL__ !== "undefined") return __CHROME_RELAY_CORE_SKILL__;
  try {
    return readFileSync(new URL("../../../../skills/chrome-relay/SKILL.md", import.meta.url), "utf8")
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .replace(/<!--[\s\S]*?-->\n*/, "")
      .trim();
  } catch {
    return "core skill unavailable in this build — see https://chrome-relay.kushalsm.com/skill.md";
  }
}

function exitWithError(error: unknown): never {
  if (error instanceof RelayError) {
    process.stderr.write(error.message + "\n");
    process.stderr.write(JSON.stringify({ relayError: error.toBridgeError() }, null, 2) + "\n");
  } else {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  }
  process.exit(1);
}

export function registerLoop(ctx: CommandContext): void {
  const { program, withBase, run } = ctx;

  // ---------- wait (Change 3) ----------
  tabOpt(
    program
      .command("wait [target]")
      .description("Block until a condition holds: a selector/@ref is visible, text appears, the URL matches, the page loads, or a JS expression is truthy. Pass a number to just sleep.")
      .option("--text <s>", "body text contains <s>")
      .option("--url <glob>", "URL matches glob (** crosses /, * doesn't)")
      .option("--load <state>", "load | domcontentloaded | networkidle")
      .option("--fn <js>", "JS expression in the page; waits until truthy")
      .option("--timeout <ms>", "max wait (default 10000, capped 25000)", (v) => Number(v))
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay wait @e12                       # ref resolves and has a box
  chrome-relay wait ".results" --tab 42        # selector exists and visible
  chrome-relay wait --text "Welcome" --tab 42
  chrome-relay wait --url "**/dashboard" --tab 42
  chrome-relay wait --load networkidle --tab 42
  chrome-relay wait --fn "window.__APP_READY === true" --tab 42
  chrome-relay wait 1500                       # plain sleep, no tab needed

Exactly one condition per call. On timeout the error includes the page's
current state (url, readyState, whether the selector exists) so you don't
need a follow-up probe.
`
      )
  ).action(async (target: string | undefined, opts) => {
    // Plain sleep: no tool call, no tab.
    if (target && /^\d+$/.test(target)) {
      const ms = Number(target);
      await new Promise((r) => setTimeout(r, ms));
      process.stdout.write(JSON.stringify({ satisfied: true, sleptMs: ms }) + "\n");
      return;
    }
    const extras: Record<string, unknown> = {};
    if (target) {
      const ref = parseRefToken(target);
      if (ref) extras.ref = ref;
      else extras.selector = target;
    }
    if (opts.text) extras.text = opts.text;
    if (opts.url) extras.urlGlob = opts.url;
    if (opts.load) extras.load = opts.load;
    if (opts.fn) extras.fn = opts.fn;
    if (typeof opts.timeout === "number") extras.timeoutMs = opts.timeout;
    await run(TOOL_NAMES.WAIT, withBase(opts, extras));
  });

  // ---------- get (Change 6) ----------
  const get = program
    .command("get")
    .description("One value, plain to stdout — no full snapshot.")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay get text @e12
  chrome-relay get value 'input[name="email"]' --tab 42
  chrome-relay get attr @e7 href
  chrome-relay get count ".result" --tab 42
  chrome-relay get title --tab 42
  chrome-relay get url --tab 42
`
    );

  const printValue = async (args: Record<string, unknown>) => {
    try {
      const result = (await callTool(TOOL_NAMES.GET, args)) as { value: unknown };
      const v = result.value;
      process.stdout.write((v === null || v === undefined ? "" : String(v)) + "\n");
    } catch (error) {
      exitWithError(error);
    }
  };
  const addressArgs = (target: string): Record<string, unknown> => {
    const ref = parseRefToken(target);
    return ref ? { ref } : { selector: target };
  };

  for (const what of ["text", "value"] as const) {
    tabOpt(
      get.command(`${what} <target>`).description(`${what === "text" ? "Visible text" : "Input value"} of a @ref or CSS selector.`)
    ).action(async (target: string, opts) => {
      await printValue(withBase(opts, { what, ...addressArgs(target) }));
    });
  }
  tabOpt(
    get.command("attr <target> <name>").description("Attribute value of a @ref or CSS selector.")
  ).action(async (target: string, name: string, opts) => {
    await printValue(withBase(opts, { what: "attr", attrName: name, ...addressArgs(target) }));
  });
  tabOpt(get.command("count <selector>").description("Number of elements matching a CSS selector.")).action(
    async (selector: string, opts) => {
      await printValue(withBase(opts, { what: "count", selector }));
    }
  );
  tabOpt(get.command("title").description("Page title.")).action(async (opts) => {
    await printValue(withBase(opts, { what: "title" }));
  });
  tabOpt(get.command("url").description("Page URL.")).action(async (opts) => {
    await printValue(withBase(opts, { what: "url" }));
  });

  // ---------- batch (Change 5) ----------
  program
    .command("batch [json]")
    .description("Run multiple tool calls in ONE round-trip, sequentially. JSON array of {name, args}, inline or via --stdin.")
    .option("--stdin", "read the JSON array from stdin")
    .option("--no-bail", "keep going after a failed command (default stops at first error)")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay batch '[
    {"name":"chrome_navigate","args":{"url":"https://chrome-relay.kushalsm.com","newTab":true}},
    {"name":"chrome_wait","args":{"load":"load"}},
    {"name":"chrome_snapshot","args":{"interactiveOnly":true}}
  ]'
  cat commands.json | chrome-relay batch --stdin

One HTTP POST, one native-messaging message, sequential execution in the
extension. Tool names are the wire names (chrome_navigate, chrome_snapshot,
chrome_click_element, ... — see \`chrome-relay call --help\`). Amortizes CLI
startup across N actions. Nested batches are rejected.
`
    )
    .action(async (json: string | undefined, opts) => {
      try {
        let raw = json;
        if (opts.stdin) {
          raw = readFileSync(0, "utf8");
        }
        if (!raw) {
          throw new RelayError({
            code: "invalid_arguments",
            message: "chrome-relay batch: pass a JSON array inline or via --stdin.",
            tool: TOOL_NAMES.BATCH,
            phase: "parse_arguments",
            retryable: false
          });
        }
        if (Buffer.byteLength(raw, "utf8") > MAX_BATCH_BYTES) {
          throw new RelayError({
            code: "invalid_arguments",
            message: `chrome-relay batch: input exceeds ${MAX_BATCH_BYTES} bytes (native-messaging frame safety). Split the batch.`,
            tool: TOOL_NAMES.BATCH,
            phase: "parse_arguments",
            retryable: false
          });
        }
        let commands: unknown;
        try {
          commands = JSON.parse(raw);
        } catch (e) {
          throw new RelayError({
            code: "invalid_arguments",
            message: `chrome-relay batch: input is not valid JSON (${e instanceof Error ? e.message : e}).`,
            tool: TOOL_NAMES.BATCH,
            phase: "parse_arguments",
            retryable: false
          });
        }
        const result = await callTool(TOOL_NAMES.BATCH, { commands, bail: opts.bail !== false });
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        const failed = (result as { results?: { ok: boolean }[] }).results?.some((r) => !r.ok);
        if (failed) process.exit(1);
      } catch (error) {
        exitWithError(error);
      }
    });

  // ---------- skills (Change 7) ----------
  const skills = program
    .command("skills [verb] [name]")
    .description("Agent playbooks shipped inside the CLI — always version-matched to the binary.")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay skills            # list available skills
  chrome-relay skills get core   # print the core usage guide

The same guide is hosted at https://chrome-relay.kushalsm.com/skill.md —
the binary copy is authoritative for the version you have installed.
`
    );
  skills.action(async (verb: string | undefined, name: string | undefined) => {
    if (!verb || verb === "list") {
      process.stdout.write("core — the Chrome Relay agent playbook (snapshot/@ref loop, text-tool table, gotchas)\n");
      return;
    }
    if (verb === "get" && (name === "core" || name === undefined)) {
      process.stdout.write(coreSkillText() + "\n");
      return;
    }
    process.stderr.write(`Unknown skill command: ${verb}${name ? ` ${name}` : ""}. Try \`chrome-relay skills\` or \`chrome-relay skills get core\`.\n`);
    process.exit(1);
  });
}
