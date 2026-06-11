// click / fill / keys / type / js / hover — trusted-input + JS-eval commands.
//
// Element-addressed commands accept @eN refs from `chrome-relay snapshot`
// in the same positional as the CSS selector (adoption-spec Change 2). The
// @ prefix keeps parsing unambiguous — a bare `e3` is a valid CSS type
// selector. A ref carries its own tab: no --tab needed, and a contradicting
// one is target_conflict.

import { parseRefToken } from "@chrome-relay/protocol";
import { tabOpt, type CommandContext } from "./shared.js";

// Route a selector-or-@ref positional into the right wire arg.
function addressArg(value: string): Record<string, unknown> {
  const ref = parseRefToken(value);
  return ref ? { ref } : { selector: value };
}

export function registerInput(ctx: CommandContext): void {
  const { program, withBase, run } = ctx;

  tabOpt(
    program
      .command("click [target]")
      .description("Click an element. Pass a @ref from `snapshot`, a CSS selector, OR --x/--y coordinates.")
      .option("--x <px>", "explicit x coordinate (CSS pixels); requires --y", (v) => Number(v))
      .option("--y <px>", "explicit y coordinate (CSS pixels); requires --x", (v) => Number(v))
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay click @e12
  chrome-relay click 'button[aria-label="Save"]'
  chrome-relay click --tab 123 --x 1327 --y 771

Prefer @refs from \`chrome-relay snapshot\` — they carry their own tab and
survive DOM churn (backendNodeId + role/name heal). CSS selectors for
elements you know statically. Coordinates for canvas/SVG chart internals
where no DOM handle exists. See docs/clicking-strategies.md.
`
      )
  ).action(async (target: string | undefined, opts) => {
    const extras: Record<string, unknown> = {};
    if (target) Object.assign(extras, addressArg(target));
    // Forward partial input — protocol parser rejects x-without-y so the
    // agent sees the typo instead of a silent fallback to selector mode.
    if (typeof opts.x === "number") extras.x = opts.x;
    if (typeof opts.y === "number") extras.y = opts.y;
    await run("chrome_click_element", withBase(opts, extras));
  });

  tabOpt(
    program
      .command("fill <target> <value>")
      .description("Fill an input or textarea. Target is a @ref from `snapshot` or a CSS selector.")
      .addHelpText(
        "after",
        `

Examples:
  chrome-relay fill @e4 "kushal@example.com"
  chrome-relay fill 'input[name="email"]' "kushal@example.com"
`
      )
  ).action(async (target: string, value: string, opts) => {
    await run("chrome_fill_or_select", withBase(opts, { ...addressArg(target), value }));
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
    await run("chrome_keyboard", withBase(opts, { keys }));
  });

  tabOpt(
    program
      .command("type <text>")
      .description("Insert text via trusted CDP input. Works in contenteditable / Draft.js / Lexical.")
      .option("-s, --selector <target>", "focus this element first (@ref or CSS selector)")
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
    const extras: Record<string, unknown> = { text };
    if (opts.selector) Object.assign(extras, addressArg(opts.selector));
    await run("chrome_type", withBase(opts, extras));
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
    const extras: Record<string, unknown> = { code };
    if (typeof opts.timeoutMs === "number") extras.timeoutMs = opts.timeoutMs;
    await run("chrome_evaluate", withBase(opts, extras));
  });

  // ---------- hover (Input.dispatchMouseEvent type=mouseMoved) ----------
  tabOpt(
    program
      .command("hover [target]")
      .description("Move the pointer over an element (@ref or CSS selector) or coordinates. Fires :hover styles.")
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
  ).action(async (target: string | undefined, opts) => {
    const extras: Record<string, unknown> = {};
    if (target) Object.assign(extras, addressArg(target));
    // Forward whatever was passed — even partial (x without y). The
    // protocol parser rejects with invalid_arguments so the agent sees
    // the typo instead of silently falling back to selector mode.
    if (typeof opts.x === "number") extras.x = opts.x;
    if (typeof opts.y === "number") extras.y = opts.y;
    await run("chrome_hover", withBase(opts, extras));
  });
}
