---
title: Why your real Chrome
description: Automation browsers give your agent a browser. Chrome Relay gives it yours — and that difference is the whole product.
nav: Why your real Chrome
order: 10
---

Every browser-automation tool for agents makes one of two choices:

1. **Launch a browser for the agent.** Playwright, Puppeteer, agent-browser — they download or spawn a separate Chrome (usually Chrome for Testing), drive it over CDP, and give the agent a clean, disposable sandbox.
2. **Attach to the browser you already use.** That's Chrome Relay.

Neither is wrong. They're different products. The sandbox is right for e2e tests, scraping, CI. But the moment the task involves *your* accounts, the sandbox has nothing to offer:

## What only exists in your real browser

**Your logins.** Here's a live test from our own benchmarking: we opened `news.ycombinator.com` in an automation browser and through Chrome Relay, same machine, same minute. The automation browser saw the logged-out page — a `login` link. Chrome Relay saw a logged-in session: username in the header, no login link anywhere. Same URL, two different realities. Every dashboard, admin panel, inbox, and internal tool your agent might operate lives exclusively in the second one.

**Cloudflare and friends.** Chrome for Testing is fingerprinted by anti-bot systems and routinely blocked or challenged. Your real Chrome is indistinguishable from you, because it *is* you. There's no stealth plugin arms race when there's nothing to disguise.

**Your extensions.** Password manager, ad blocker, that internal company extension — present and working.

**localhost.** The dev server you're running, with whatever auth state your browser already negotiated with it.

**No credential handoff.** The alternative way to get an agent "logged in" is exporting cookies or storing credentials in a vault it can replay. With Chrome Relay there's nothing to export — the session never leaves the browser it lives in.

## The objections, honestly

**"Isn't attaching to my real browser dangerous?"** It's a real trade and you should make it consciously. Two things bound the risk:

- *Scope.* Everything is local: CLI → `127.0.0.1` → native messaging → extension. The bridge binds to localhost only and rejects browser-origin requests, so a web page can't call it. There's no cloud relay that could be compromised, no account that could leak.
- *Visibility.* The agent acts in tabs you can see (or background tabs you can switch to). Actions are auditable in your own browser history and the agent's transcript. Contrast with a sandbox browser doing things in a window you'll never look at.

What it doesn't bound: an agent with your sessions can do what you can do. That's the point, and it's why Chrome Relay favors strict, loud failure over silent cleverness — structured error codes, no auto-fallbacks, refusal to click through overlays (`click_intercepted`). You should know what your agent did and why.

**"Why not just launch Chrome with `--remote-debugging-port`?"** Because that requires *relaunching* Chrome (killing your session), and it exposes the raw debugging protocol — every tab, every cookie — to any process on the machine that can reach the port. The extension + native-messaging route attaches to the already-running browser, with Chrome's own permission model in front of it, scoped to one whitelisted local binary. [Architecture](/docs/architecture/) covers this in detail.

**"Won't the agent steal my focus while I work?"** No — that constraint shaped the whole design. Commands run on background tabs via CDP; the extension even patches `document.visibilityState` so pages keep behaving normally while backgrounded. You browse in one tab while the agent works in another. Multiple agents can drive separate named windows ([workspaces](/docs/workspaces/)).

## When you should NOT use Chrome Relay

Honesty section. Use a sandbox browser instead when:

- You're running **CI or e2e tests** — you want determinism and a clean profile, not your cookies.
- You're **scraping at volume** — you want parallel disposable sessions.
- The task needs **no auth at all** — the sandbox is simpler and can't touch anything of yours.
- You can't supervise it and the blast radius of "the agent can do what I can do" is unacceptable.

The two-line summary we'd want an agent to remember:

> agent-browser (and Playwright) are what your agent uses to browse *the web*.
> Chrome Relay is what your agent uses to operate *your* web — logged-in, real-profile, without taking the browser away from you.
