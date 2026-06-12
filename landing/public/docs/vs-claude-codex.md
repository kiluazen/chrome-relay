# vs Claude in Chrome & Codex

> All three drive your real logged-in Chrome. The genuine difference is one thing — who can invoke it.


Anthropic ships [Claude in Chrome](https://claude.com/blog/claude-for-chrome). OpenAI ships a [Codex Chrome extension](https://developers.openai.com/codex/app/chrome-extension). Both do what Chrome Relay does at the core: let an agent act in the browser you're actually signed into — clicks, forms, page reads, console, network, screenshots. If you expected a capability war here, there isn't one.

The genuine difference is **who can invoke it**:

- **Claude in Chrome** is invoked by Claude — the claude.ai side panel or Claude Code's `--chrome`. Paid plans only (Pro/Max/Team/Enterprise, beta), Chrome and Edge.
- **Codex's extension** is invoked by the Codex desktop app (`@Chrome` mentions). It isn't even available from the Codex *CLI* — that's an [open feature request](https://github.com/openai/codex/issues/22164).
- **Chrome Relay** is a CLI. Anything that runs shell commands can invoke it — Claude Code, Codex CLI, a cron job, a CI-triggered script on your machine, the next agent that doesn't exist yet. Free, open source, no plan gating.

So the choice is mostly already made by your setup:

| Your situation | Use |
|---|---|
| You live in Claude (claude.ai or Claude Code) and its built-in browser control covers you | Claude in Chrome — it's right there |
| You live in the Codex desktop app | Codex's extension — same |
| You run more than one agent, or want scripts/automation to drive the browser, or your agent has no vendor extension | Chrome Relay |

## Measured head-to-head, same logged-in dashboard

We ran the Codex Chrome extension and Chrome Relay through the same read-only path in a real authenticated Cloudflare dashboard — overview, Security Insights, a Details drawer, Cmd+K command palette to Audit Logs, Pages metrics (2026-06-12, live):

| Surface | Codex extension (`domSnapshot`) | Chrome Relay (`snapshot -i` / full) |
|---|---:|---:|
| Dashboard overview | 21.4 KB | 4.9 KB / 8.6 KB |
| Security Details drawer | 31.0 KB | 11.5 KB |
| Pages metrics | 18.3 KB | 6.6 KB full |
| Command palette mid-flow | — | **393 bytes**, with the selected option as a clickable ref |

Both completed the whole path — capability is a tie, which is the honest headline. The deltas are payload size and the loop shape: Codex's API is JavaScript objects inside its runtime (`tab.playwright.getByRole(...)`, locator disambiguation when three links match); Chrome Relay's is text refs in a shell (`click @e147`). One observed caveat cuts our way *and* against us: `snapshot -i` is for **acting** — it dropped the Pages metrics *values* (use full `snapshot` or [`get`](/docs/commands/) to read facts), while Codex's bigger dumps carried them by default.

## The secondary differences, honestly

**Safety posture.** The vendor extensions ship supervised-mode machinery Chrome Relay doesn't: per-site permission prompts, "ask before acting", confirmation gates on risky actions, default-blocked site categories. Chrome Relay's model is one trust decision at install — local processes that can run the CLI can drive the browser — with strict, loud failures rather than per-action prompts ([architecture](/docs/architecture/)). If you want a permission prompt before every click, the vendor extensions do that and we don't.

**Focus model.** Claude in Chrome runs "in a visible Chrome window in real time." Codex works in its own tab groups alongside yours. Chrome Relay runs on background tabs without activating them (and keeps pages behaving as if visible), which is what makes [parallel agents in named windows](/docs/workspaces/) practical.

**Scriptability.** Vendor extensions are reachable only from inside their vendor's product session. Chrome Relay is a binary: pipe it, cron it, call it from any harness.

**Cost coupling.** Browser actions through vendor extensions consume your plan's usage limits. Chrome Relay costs whatever your agent's tokens cost — the tool itself adds nothing.

**Debugging surface.** Chrome Relay exposes the network ring buffer (request/response metadata, on-demand bodies, HAR export) alongside console — in the live test it captured the dashboard's GraphQL calls with statuses and timings. The vendor extensions expose console logs and screenshots; comparable raw network capture wasn't in their exposed surface. Flip side stated plainly: network output carries auth headers, so [redact before sharing](/docs/observability/) — a narrower surface is also a safety feature, and theirs is narrower.

## Adjacent: vendor-neutral MCP bridges

Playwright MCP's extension mode, Chrome DevTools MCP, and Browser MCP also connect agents to a real Chrome, vendor-neutrally, over MCP. The honest difference there is interface economics: MCP tool schemas occupy context on every turn, a CLI occupies none until used — plus Chrome Relay's [snapshot/ref loop](/docs/refs/) and [structured errors](/docs/errors/) are built for agent loops specifically. Same family, different interface bet.

And if you don't need *your* browser at all — fresh-profile scraping, e2e tests, CI fleets — none of the above is the right tool: see [vs agent-browser](/docs/vs-agent-browser/).
