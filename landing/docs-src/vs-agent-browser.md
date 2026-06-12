---
title: vs agent-browser
description: Different products that look alike. Measured, with respect — and a clear rule for which to pick.
nav: vs agent-browser
order: 30
---

[agent-browser](https://agent-browser.dev) is Vercel Labs' browser-automation CLI for agents. It's good — fast, token-efficient, and its snapshot/ref loop set the bar (Chrome Relay's own loop ergonomics owe it a debt, openly). If you're choosing tooling, here's the honest comparison.

## The one-line difference

**agent-browser gives your agent a browser. Chrome Relay gives your agent *yours*.**

agent-browser downloads its own Chrome for Testing and drives it headless behind a daemon — a fresh, disposable sandbox. Chrome Relay attaches to the Chrome you're already using, with everything that implies: your logins, your extensions, your localhost, and a human sharing the browser.

| | agent-browser | Chrome Relay |
|---|---|---|
| Browser | its own Chrome for Testing, headless by default | the one you have open |
| Auth state | none (profile copy is a read-only snapshot) | everything you're signed into |
| Anti-bot (Cloudflare etc.) | fingerprinted as automation, often blocked | indistinguishable from you |
| Parallel isolated sessions | yes — its core strength | one browser; isolation via [workspaces](/docs/workspaces/) |
| CI / headless servers | yes | no — needs a running desktop Chrome |
| Human + agent simultaneously | n/a — the agent owns the browser | yes — background tabs, no focus stealing |
| Attach to a real Chrome | via `--cdp` debug port (requires relaunching Chrome; port exposes everything to localhost) | native: extension + native messaging, no relaunch, Chrome-gated |

We tested both on the same machine, same minute, same URL: agent-browser's Chrome saw logged-out Hacker News; Chrome Relay saw a logged-in session. Every page behind auth only exists in one of those worlds.

## The ergonomics are now comparable

The historical knock on real-browser bridges was clunky loops. Measured today, same page (HN front page):

| | agent-browser | Chrome Relay |
|---|---|---|
| Interactive snapshot | 13.5 KB | 14.3 KB |
| Act on an element | `click @e12` | `click @e12` |
| Click round-trip | ~40 ms | ~150 ms |

The remaining latency gap is Node process startup vs a Rust binary — real, and irrelevant next to LLM turn time. Two places Chrome Relay's loop goes further:

- **Refs heal.** agent-browser's refs go stale on any DOM change, and its docs tell agents to re-snapshot constantly — a real-world migration measured ~30% of turns burned on re-snapshots. Chrome Relay refs survive same-page churn via a role/name re-find that writes the fix back; they die only on [real navigation](/docs/refs/), loudly.
- **Refs are tab-safe under a human.** In a browser only the agent uses, "active tab" is unambiguous. In *your* browser it's whatever you're reading — so Chrome Relay refs carry their tab, and a bare `click @e12` can never land in your inbox.

agent-browser counters with breadth Chrome Relay doesn't have: built-in `wait` primitives, snapshot diffs, batch execution, video, traces, proxies, cloud-provider backends. If you need those today, that's a real reason to pick it.

## The rule

- **E2E tests, CI, scraping, parallel fleets, no auth needed** → agent-browser (or Playwright). The sandbox is the feature.
- **Operating apps you're signed into, debugging your own logged-in product, anything behind SSO or Cloudflare, working alongside the agent** → Chrome Relay. The real browser is the feature.

They compose, too: plenty of workflows scrape with a sandbox and act with the real browser. Nothing about installing one precludes the other.
