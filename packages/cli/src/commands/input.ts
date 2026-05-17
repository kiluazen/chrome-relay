// click / fill / keys / type / js / hover — trusted-input + JS-eval commands.

import { tabOpt, type CommandContext } from "./shared.js";

export function registerInput(ctx: CommandContext): void {
  const { program, baseArgs, run } = ctx;

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
}
