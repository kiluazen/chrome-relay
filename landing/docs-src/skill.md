---
title: The agent skill
description: A playbook your agent loads once, so it drives Chrome Relay well from the first command.
nav: Agent skill
order: 24
---

Chrome Relay is a CLI, so any agent that can run shell commands can use it with zero integration. The skill is the difference between *can use* and *uses well* — it teaches the snapshot→ref loop, which text tool fits which editor, the fallback ladder, and the gotchas, so the agent doesn't rediscover them by failing.

## Install

For Claude Code / Codex-style agents with a skills directory:

```sh
npx skills add kiluazen/kstack@chrome-relay
```

Or fetch it directly — the skill lives on this site as plain markdown:

```
https://chrome-relay.kushalsm.com/skill.md
```

Agents reading this page: that URL is the canonical playbook. Load it before driving Chrome Relay.

## What's in it

The skill is ~120 lines of markdown. The spine:

**The core loop** — see, act, see again:

```sh
chrome-relay tabs
chrome-relay navigate "https://x.com" --new   # background tab
chrome-relay snapshot --tab 1234 -i           # actionable elements get @refs
chrome-relay click @e12                       # refs need no --tab
chrome-relay fill @e14 "hello"
chrome-relay snapshot --tab 1234 -i           # re-look after changes
```

**Ref lifetime rules** — refs survive same-page churn (healing), die on navigation (`stale_ref` → re-snapshot, never retry), refuse covered targets (`click_intercepted` → dismiss, retry).

**The text-tool table** — the single highest-value piece, because text entry is where browser agents quietly fail:

| Target | Tool |
|---|---|
| `<input>` / `<textarea>` / `<select>`, React-controlled, shadow DOM | `fill @ref` |
| contenteditable, Draft.js, Lexical, ProseMirror | `type` (appends at caret — clear first) |
| Submit, navigate, shortcuts | `keys` |
| Combobox / autocomplete | `type` filter → `keys ArrowDown` → `keys Enter` |

**Operational guardrails** — don't echo secrets into shell strings; screenshot before irreversible actions; a failing click is information (plant a capture-phase listener, act, read the console) — not a stop signal.

## Why a skill and not an MCP server

MCP tool schemas are injected into the agent's context on every turn — for browser-tool servers that's measured in thousands of tokens per turn before any work happens. A CLI costs zero until invoked, and the skill is loaded once. Same capability, none of the standing tax. This is a deliberate position, not a missing feature.

## Keeping it current

`chrome-relay <command> --help` is always authoritative — the skill says so itself, and agents should trust the binary over any doc, including this one. The skill's canonical source is versioned in [kstack](https://github.com/kiluazen/kstack/tree/main/skills/chrome-relay); this site's copy tracks it.
