# chrome-relay vs agent-browser

Research date: 2026-06-11. Hands-on tested both on the same machine, same page (news.ycombinator.com). agent-browser v0.27.x (35.8k stars, Vercel Labs, Apache-2.0, launched Jan 2026 by Chris Tate as a weekend project).

## The one-line difference

**agent-browser gives your agent a browser. chrome-relay gives your agent *your* browser.**

agent-browser downloads its own Chrome for Testing, runs it headless behind a Rust daemon, and optimizes the agent loop to the bone. It's a sandbox: fresh profile, no logins, no extensions, no history. `--profile Default` only copies your profile to a temp dir as a read-only snapshot. `--cdp 9222` can attach to a real Chrome — but only if you relaunch Chrome with a debug flag, which kills your running session and exposes raw CDP to everything on localhost.

chrome-relay attaches to the Chrome that's already running — real cookies, real logins, real extensions — via extension + native messaging, no relaunch, no debug port. It works on background tabs without stealing focus while you keep using the browser.

Live proof from testing: opened HN in both. agent-browser's Chrome saw the logged-out page with a `login` link. chrome-relay's view had no login link at all — because Kushal is logged in. Same URL, different reality. Everything behind auth (dashboards, admin panels, Gmail, anything with Cloudflare fingerprinting that blocks Chrome-for-Testing) only exists in the chrome-relay world.

So they're not actually the same product:

| | agent-browser | chrome-relay |
|---|---|---|
| Browser | its own Chrome for Testing, headless default | your running Chrome |
| Auth state | none (or read-only profile copy) | everything you're logged into |
| Transport | Rust CLI → unix socket → daemon → raw CDP | Node CLI → localhost HTTP → native host → extension → chrome.debugger CDP |
| Use case | e2e tests, scraping, CI, parallel sessions | operating *your* web apps, debugging logged-in flows, anything behind auth |
| Anti-bot | fingerprinted and blocked by Cloudflare | indistinguishable from you (it *is* you) |

That's the moat. Don't compete on "browser for agents" — Playwright and agent-browser own that. Compete on "your browser, agent-operable."

## Where agent-browser is genuinely ahead

The uncomfortable part. Measured on the same HN front page:

| output | agent-browser | chrome-relay |
|---|---|---|
| full snapshot | 27.5 KB (`snapshot`) | 93 KB (`read`), **337 KB** (`ax`) |
| interactive-only | **13.5 KB** (`snapshot -i`) | 61 KB (`read -i`), 23 KB (`ax --interactive-only`) |
| command latency | 26–47 ms (warm daemon) | 150–260 ms (Node startup dominates) |
| click round-trip | `click @e110` → 37 ms | selector echo → 160 ms |

### 1. Their action loop is closed. Ours is broken.

agent-browser: `snapshot -i` → `click @e3` → done. The ref in the snapshot IS the handle for every action.

chrome-relay: `read` emits `ref_1…ref_N` — **and no command accepts them.** `click` takes a CSS selector or coordinates. So the agent must echo back a 100+ char brittle selector like `tr:nth-of-type(1) > td:nth-of-type(2) > span:nth-of-type(1) > b:nth-of-type(1) > a:nth-of-type(1)`. Or run a *different* snapshot (`ax`) to get backendDOMNodeIds for a *different* click command (`click-ax`). Two snapshot systems, two id spaces, refs that go nowhere.

### 2. Output format is the whole token game

agent-browser snapshot is plain indented text, one element per line:

```
- link "Hacker News" [ref=e102]
- cell "1." [ref=e10]
```

chrome-relay `read -i` is pretty-printed JSON where each element costs ~300 bytes: a `bounds` object (4 keys), the giant selector string, verbose key names, 2-space indentation. That's why the same page costs 4.5× more. None of bounds/selector is needed in the default view if refs are actionable — the agent only needs `ref [role] "text" (state)`.

### 3. Things they have that agents actually use

- **`wait`** — `wait <sel>`, `wait --text "Welcome"`, `wait --url "**/dash"`, `wait --load networkidle`, `wait --fn <js>`. chrome-relay has nothing; agents sleep and re-read.
- **`get text|value|attr|count <sel>`** — one value without a full snapshot.
- **`find role button click` / find text/label/placeholder/testid** — deterministic semantic locators, the fallback when refs are stale.
- **`diff snapshot`** — only what changed since last snapshot, ~100 tokens. Directly attacks the re-snapshot tax.
- **`batch "open url" "snapshot" "click @e1"`** — N actions, one process spawn.
- **`skills get core`** — the agent guide ships inside the CLI, always version-matched. Their SKILL.md is deliberately thin: "run `agent-browser skills get core` at runtime." Smart distribution.
- **`screenshot --annotate`** — numbered overlays on the image that map to snapshot refs. Vision + refs in one artifact.
- cookies/storage/state save-load (already on our roadmap), HAR, video, traces, vitals, react inspection.

### 4. Where the hype cracks (don't copy these)

- **Ref staleness is their #1 real-world complaint.** Issue #1351: a 150-case e2e migration from Playwright MCP took **+65% more LLM calls** because ~30% of turns were re-snapshots after refs went stale. The per-snapshot token win got eaten by turn count. Their refs die on every DOM change; nothing auto-refreshes.
- **"100% Rust" is distribution, not product.** Rust matters for *them* (no Node dependency for install). chrome-relay's extension is necessarily JS and the Node CLI's ~110ms startup is real but not the bottleneck — output tokens and round-trip count are. A Rust rewrite would be vibes. An independent source-read (wasnotwas.com) found their Rust ARIA renderer is actually *noisier* than the deleted Node/Playwright path.
- **Reception is lopsided**: 35.8k stars but near-zero HN traction (2-point submissions), 517 open issues at 5 months, Vercel Labs (not core) with one dominant contributor.
- Sandboxed Chrome is blocked by Cloudflare/anti-bot, loses device context between opens, and a field test scored it 6.1/10 vs Playwright's 8.0 on test-writing quality.

## What to build (priority order)

1. **Compact text snapshot as default output.** One line per element: `ref_3 [link] "Hacker News"`. JSON behind `--json`. Drop bounds + selector from default (flag-gated). This alone is a ~5–10× token cut and costs a renderer, nothing architectural.
2. **Close the ref loop.** `click ref_3`, `fill ref_5 "x"`, `hover ref_2` — extension keeps a per-tab ref→backendNodeId map from the last snapshot. This kills the brittle-selector echo entirely and beats their refs (backendNodeIds survive DOM mutations that don't replace the node — their `@eN` refs die on any change).
3. **Unify `read` and `ax` into one `snapshot`** with one ref space. Two snapshot systems with incompatible ids is pure confusion tax. (`ax` full output was 337 KB — *bigger* than `read` — because it walks the whole tree unfiltered; the "30× smaller" claim only holds with `--interactive-only`.)
4. **`wait`** — selector / text / url-glob / networkidle / js-fn. Cheap via CDP, removes the sleep-and-re-read loop.
5. **Snapshot diff.** `read --diff` returns only changed elements since the last snapshot of that tab. Their #1 weakness (re-snapshot tax) becomes our win — we hold per-tab state in the extension already (console/network ring buffers prove the pattern).
6. **`find role|text|label <value> <action>`** — deterministic semantic locator. Better and cheaper than the planned natural-language resolver; ship that later on top.
7. **`get text|value|attr|count`** one-liners.
8. **`batch`** — array of commands in one invocation; also amortizes the Node startup.
9. **`skills get core` in the CLI** — version-matched agent guide, thin SKILL.md that defers to the binary.
10. **Error hygiene** — seen live: element-not-found surfaced as `internal_error` with a raw JS stack instead of `element_not_found`. The structured codes exist; older handlers bypass them.

Non-goals: Rust rewrite, headless/sandbox mode, cloud providers, an MCP server (their zero-MCP stance is right — tool schemas cost ~13–17k tokens/turn; CLI + skill is the correct interface).

## Positioning line

agent-browser is what your agent uses to browse the web. chrome-relay is what your agent uses to operate *your* web — the logged-in, real-profile, real-extensions Chrome you're already sitting in, without taking it over. Match their loop ergonomics (1–4 above) and the token story is equal while the auth story is unanswerable.
