# One CLI, many browsers — how the mediation works

The question this doc answers: *"each of my Chrome profiles has the
extension, Dia has the extension — so one CLI is connecting to three
extensions. How does that work?"*

Short answer: **it doesn't connect to three extensions. It picks one, every
time.** There are three separate extension↔host pipes, a registry that
lists them, and a stateless CLI that reads the registry, chooses exactly one
pipe per command, and sends the command down it. No daemon, no multiplexer,
no shared state between calls.

## The pieces

```
 Chrome (profile "main")        Chrome (profile "second")        Dia
 ┌─────────────────────┐        ┌─────────────────────┐   ┌──────────────┐
 │ extension            │        │ extension            │   │ extension     │
 │ instanceId 66a3…     │        │ instanceId 5f85…     │   │ instanceId    │
 └────────┬────────────┘        └────────┬────────────┘   │ d995…         │
          │ native messaging             │                 └──────┬───────┘
          │ (stdio, 1:1)                 │                        │
 ┌────────▼────────────┐        ┌────────▼────────────┐   ┌──────▼───────┐
 │ native host #1       │        │ native host #2       │   │ native host #3│
 │ 127.0.0.1:58807      │        │ 127.0.0.1:58826      │   │ 127.0.0.1:…   │
 └────────┬────────────┘        └────────┬────────────┘   └──────┬───────┘
          │  writes                      │  writes                │  writes
          ▼                              ▼                        ▼
        ~/.chrome-relay/instances/<instanceId>.json   (one file per host)
                                  ▲
                                  │ reads + pings, picks ONE
                          ┌───────┴────────┐
                          │  chrome-relay   │   (a fresh process per command)
                          └────────────────┘
```

**Native messaging is 1:1.** Chrome's `connectNative` spawns one host
process per extension instance and gives them a private stdin/stdout pipe.
That pairing is Chrome's, not ours — a host physically cannot talk to any
extension except the one that spawned it. Three extension instances
therefore means three host processes. This is why there's no "one
connection to three extensions": the browser platform forbids it, and the
design leans into that instead of fighting it.

**Each host announces itself.** On start it binds a random localhost port,
and once its extension says hello (carrying the profile's minted
`instanceId`), it writes a descriptor file: instanceId, port, an auth
token, its pid, which browser spawned it (read from its parent process —
"Google Chrome", "Dia"), versions. On exit it removes the file
(generation-guarded, so a stale host can never delete a fresh one's file).

**The CLI is stateless.** Every `chrome-relay <cmd>` is a new process that:

1. reads `~/.chrome-relay/instances/`,
2. pings each descriptor's port — the handshake must echo the descriptor's
   instanceId + generation (*the registry is discovery; the handshake is
   the authority* — files can be stale, ports can be reused),
3. picks **exactly one** host by the routing rules below,
4. POSTs the tool call to that host with its bearer token,
5. prints the result, stamped with which profile served it.

There is deliberately no long-lived broker process. The registry directory
*is* the coordination point, and the ping is what makes a file trustworthy.

## Routing: how "one" gets picked

| Situation | Behavior |
|---|---|
| One instance connected | Everything routes to it. No flags, ever. |
| Several connected, command has `--profile <label\|idprefix>` | Routes to the match. No match → `profile_not_found`; several → `profile_ambiguous`. |
| Several connected, command carries a qualified ref (`@d995:e12`) | The token routes by itself — the 4-hex prefix names the minting instance. `--profile` may accompany it but must agree (`target_conflict` otherwise). |
| Several connected, no scope at all | **Hard fail `profile_ambiguous`, candidates listed.** The CLI never guesses — a guessed click in the wrong browser is the worst failure class. |
| An instance is registered but not answering | It still counts toward ambiguity (a transient hiccup must not turn an ambiguous command into a single-profile one); targeting it fails retryable. |
| No v2 instances at all | Legacy fixed-port fallback (`12122`) — pre-0.8 behavior for pre-0.8 extensions. |

Refs make most of this invisible in practice: `snapshot` prints
`[ref=d995:e12]`, the agent copies `@d995:e12`, and every later action on
that token lands in the right browser without any flag — the ref *carries*
its profile the same way it has always carried its tab.

Identity notes: profiles can't be discovered (Chrome hides profile names
from extensions), so each extension **mints** a stable UUID; you attach
human names with `chrome-relay profile label <name>` (stored CLI-side in
`~/.chrome-relay/labels.json`, unique, freed by `profile unlabel`). The
browser name is detected by the host from its parent process — the one
identity source that needs nothing from the extension and can't be wrong.

## Failure modes an agent should know

- `profile_ambiguous` → list candidates from the error details, retry with
  `--profile`. Not retryable as-is; it's asking you to choose.
- `profile_not_found` → the profile that minted your ref isn't reachable;
  re-run `snapshot` in the profile you meant.
- `target_conflict` → your `--profile` and your ref disagree; drop one.
- `extension_not_connected` (retryable, with `unresolved` details) → a
  registered host didn't answer; usually mid-restart. Retry.
- `unauthorized` → your descriptor was stale; re-discovery fixes it on the
  next call.

## Known clarity gaps (candidates for the next release, not hot-edits)

1. **Top-level `--help` says nothing about any of this.** Its Notes explain
   refs and CDP but not the one-host-per-instance model or `--profile`.
   The first `profile_ambiguous` an agent ever sees is currently the first
   time it learns multiple profiles exist. Proposed: a short "several
   browsers/profiles?" paragraph in the main help, pointing at
   `profile list`.
2. **The skill** (`skills/chrome-relay/SKILL.md`) predates 0.8.0 — no
   mention of profiles, qualified refs, or upload. Now that 0.8.0 is live
   in the store and on npm, it's eligible for the update.
3. **`doctor` vs `profile list` overlap** — doctor shows the registry too;
   one of them should be the canonical "what can I reach" answer.
4. A **`chrome-relay status`**-style one-liner (instances + who owns the
   legacy port + which one an unscoped command would pick) would make the
   mediation self-explaining at a glance.

All four ride the normal release train. This doc is the source they
graduate from.
