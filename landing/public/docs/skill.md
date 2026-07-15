# The agent skill

> A playbook your agent loads once, so it drives Chrome Relay well from the first command.


Chrome Relay is a CLI, so any agent that can run shell commands can use it with zero integration.

The skill is the difference between *can use* and *uses well*. It teaches the snapshot/ref loop, which text tool fits which editor, the fallback ladder, and the gotchas, so the agent doesn't rediscover them by failing.

## Install

If the CLI is installed, use the version-matched copy:

```sh
chrome-relay skills get core
```

For Claude Code / Codex-style agents with a skills directory:

```sh
npx -y skills add kiluazen/kstack@chrome-relay
```

The `-y` auto-confirms npx's "install the `skills` package?" prompt, so an agent running headless doesn't hang waiting for a TTY.

Or fetch it directly. The skill lives on this site as plain markdown:

```
https://chrome-relay.kushalsm.com/skill.md
```

Agents reading this page: load either the CLI playbook or that URL before driving Chrome Relay.

## What's in it

The spine:

**The core loop**

See, act, see again:

```sh
chrome-relay tabs
chrome-relay navigate "https://kushalsm.com" --new   # background tab
chrome-relay snapshot --tab 1234 -i           # actionable elements get @refs
chrome-relay click @e12                       # refs need no --tab
chrome-relay fill @e14 "hello"
chrome-relay snapshot --tab 1234 -i           # re-look after changes
```

**Ref lifetime rules**

Refs survive same-page churn. They die on navigation. `stale_ref` means re-snapshot and never retry the old ref. `click_intercepted` means dismiss the cover or scroll, then retry.

**Multiple browsers and profiles**

The 0.8 skill begins by checking `chrome-relay profile list`. One connected browser/profile routes implicitly. With several, `profile_ambiguous` is a picker: choose an exact `--profile <label|idprefix>` entry and rerun. Qualified refs such as `@3f2a:e12` carry both their browser profile and tab, so later actions route themselves.

**The text-tool table**

The highest-value part, because text entry is where browser agents quietly fail:

| Target | Tool |
|---|---|
| `<input>` / `<textarea>` / `<select>`, React-controlled, shadow DOM | `fill @ref` |
| contenteditable, Draft.js, Lexical, ProseMirror | `type`. Appends at caret, so clear first |
| Submit, navigate, shortcuts | `keys` |
| Combobox / autocomplete | `type` filter, `keys ArrowDown`, `keys Enter` |

**Operational guardrails**

Don't echo secrets into shell strings. Screenshot before irreversible actions. A failing click is information, not a stop signal. Plant a capture-phase listener, act, then read the console.

## Why a skill and not an MCP server

MCP tool schemas are injected into the agent's context on every turn. For browser-tool servers, that can mean thousands of tokens before any work happens.

A CLI costs zero until invoked, and the skill is loaded once.

Same capability, none of the standing tax. This is a deliberate position, not a missing feature.

## Keeping it current

`chrome-relay <command> --help` is always authoritative. The skill says so itself, and agents should trust the binary over any doc, including this one.

The skill's canonical source is versioned in [kstack](https://github.com/kiluazen/kstack/tree/main/skills/chrome-relay). This site's copy tracks it.
