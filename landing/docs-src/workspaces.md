---
title: Workspaces & tab groups
description: Named Chrome windows so multiple agents work in parallel without colliding — or with you.
nav: Workspaces
order: 22
---

One browser, several actors: you, and however many agents you've got running. Workspaces keep them out of each other's way.

## Workspaces — named windows

```sh
chrome-relay workspace create research          # opens a new Chrome window, names it
chrome-relay workspace list                     # name, windowId, tabCount, alive
chrome-relay workspace close research
```

Every command accepts `--workspace <name>` to target the active tab *in that window*:

```sh
chrome-relay --workspace research navigate "https://example.com" --new
chrome-relay snapshot --workspace research -i
chrome-relay screenshot --workspace research -o out.png
```

The pattern this enables: give each agent its own workspace. Agent A drives the `research` window, agent B drives `checkout-flow`, and your own window is never touched. Since everything runs on background tabs anyway, none of them steals your focus.

## Tab groups — folders inside a window

```sh
chrome-relay group create sources --color blue --tab 42   # Chrome's native colored groups
chrome-relay group add sources --tab 43 --tab 44
chrome-relay group list
chrome-relay group remove sources --tab 43
chrome-relay group close sources                          # closes the group's tabs
```

And `--group <name>` targets the active tab inside a group, same as `--workspace`.

Groups are lighter than workspaces — same window, visual organization, one collapse-click for the human watching. Use workspaces for isolation between agents; use groups for organizing one agent's working set.

## Targeting rules (strict on purpose)

- Exactly **one** of `--tab` / `--workspace` / `--group` per command. Two at once is `target_conflict`, not a guess.
- Subcommand-level flags override program-level ones, and the override is announced on stderr (`target_overridden`) so it's never silent.
- [Ref](/docs/refs/) actions ignore all of this — a ref carries its own tab, and combining it with `--workspace`/`--group` is `target_conflict`.

## Viewport per tab

Emulation composes with all of it — each tab can hold its own device profile:

```sh
chrome-relay viewport preset iphone-14 --workspace research
chrome-relay viewport set --width 390 --height 844 --dpr 3 --mobile --touch --tab 42
chrome-relay viewport clear --tab 42
```

Survives navigation, cleared when the tab closes. Useful for checking responsive layouts in one window while desktop work continues in another.
