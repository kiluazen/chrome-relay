# chrome-relay CLI philosophy

This is the opinionated meta-doc behind every design decision in chrome-relay. It exists because we keep restating it across reviews — better to write it once and point at it.

## What chrome-relay is

A CDP channel into the user's real Chrome session, driven by an agent's terminal. Real cookies, real auth, real DOM. Most operations run on backgrounded tabs without stealing focus. The user keeps working; the agent operates beneath.

## The product principle

> If chrome-relay cannot do exactly what was requested, it should fail with a precise error. If partial success is intentionally allowed, partial success must be explicit in the output shape.

That sentence is the entire spec. Everything below is consequence.

## Who chrome-relay serves

Agents. Not humans.

A human at a CLI can recover from ambiguity: read the prose, notice the wrong tab activated, retry. An agent reads the JSON result, treats it as ground truth, and builds the next step on top of it. If we lie or hand-wave, the agent compounds the error five steps later, and debugging starts three layers away from the actual cause.

So: every output should be debuggable from the agent's transcript alone, with no human-in-the-loop "check the browser to see what really happened."

## The choices that fall out

### 1. Expose precise primitives. Don't auto-fallback.

When clicking can fail in five different ways — wrong selector, stale element, accessibility-tree miss, page not visible yet, anti-bot gate — we make the agent **pick which strategy** they're using. Each verb has one strategy, one failure mode, one debug path.

We do not have one `click` that tries selector → ax → text-walker → coords behind the scenes. That would silently click the wrong element on a sibling card with similar text and the agent would never know why downstream things broke.

The cost of this discipline: more CLI surface. The benefit: when the call fails, the failure is the strategy. The agent knows what to try next.

### 2. Hide things only when the right answer is obvious *and* uniform.

force-visibility-on-attach (0.5.17) is the canonical example. Every site that gates JS on `document.visibilityState` benefits from being lied to. The right default is "be visible." There's no site we operate on where "be hidden" is the better answer. So we hide the toggle, set the default to true, and the agent doesn't have to think about it.

Click strategy is the inverse — each strategy fits a different site profile. We expose verbs. The agent picks.

The rule: **hide what has an obviously-right uniform default; expose what affects debuggability of failures.**

### 3. Errors are structured values, not strings.

Every failure surfaces as `RelayError` with a `code`, `tool`, `phase`, and `details`. Agents branch on `code === "target_not_found"`, not on regex-matching a message. Messages are for humans reading transcripts; codes are for agents writing logic.

The codes are a closed set in `packages/protocol`. Adding a new code is a deliberate protocol change, not a free-form string field.

### 4. Strict by default. Best-effort as an opt-in flag.

`chrome-relay network har --with-bodies` fails the whole call if a single body can't be fetched. `--best-effort-bodies` is a separate flag that opts back into the legacy permissive behavior.

`chrome-relay navigate --new --group X` fails if the new tab can't join group X. `--allow-partial` is the opt-in for "I'll accept the tab landing without the group binding, just tell me about it."

Default = the agent's reasonable expectation. Best-effort = explicit "I know I'm asking for something fuzzy, return what you got and flag what you didn't."

This is the opposite of most legacy CLIs, which default to "do whatever, return success." Those CLIs were built for humans who can spot anomalies. Ours is built for agents that can't.

### 5. Truth in the protocol layer; affordances in the CLI layer.

The wire format between extension and CLI carries structured codes, typed argument shapes, typed result shapes. The CLI is allowed to provide convenience wrappers — pretty-printing, flag aliases, batched calls — as long as those wrappers don't lie about what happened.

When an agent calls `chrome-relay screencast stop --gif`, the CLI wraps multiple operations (stop the screencast, dedupe frames, ffmpeg-stitch). If ffmpeg is missing, the call fails with `external_dependency_missing`, not "succeeded with warning." The convenience wrapper does not get to silently degrade.

### 6. No silent fallback to "active tab" or "default" or "the first thing we found."

If the agent passes `--tab 999` and tab 999 doesn't exist, we fail with `target_not_found`. We don't fall back to the active tab "to be helpful." Helpful is dangerous when the agent's plan was specifically about tab 999.

`allowPartial: true` exists for cases where the agent actively wants the fallback. Without that flag, strict.

### 7. Tools are versioned and changelog'd in machine-readable form.

`chrome-relay update` returns structured JSON describing what changed, scoped to the agent's previous version. Release notes are an executable contract, not a markdown file in a repo.

This is the corollary of "build for agents." Agents don't read CHANGELOG.md. They run `update`, get a structured diff of what's new, decide whether to use the new capability.

## The kinds of complexity we DO hide

Things that have an obviously-right uniform answer, where exposing the lever would just be noise:

- `force-visibility-on-attach` — every site benefits from being lied to about its visibility state.
- CDP debugger lifecycle — we attach/detach automatically; agents don't manage sessions.
- Native-host process management — agent doesn't see the bridge restart.
- Bridge protocol version negotiation — agent doesn't pick a wire version.

When a lever's default is uniformly right, the lever becomes implementation detail.

## The kinds of complexity we DON'T hide

Things that affect what the agent should do next when something fails:

- **Click strategy** — selector / ax / text / coords / js each fit different sites. Expose verbs.
- **Error codes** — every failure carries a code so the agent can branch.
- **Partial-success flags** — agent opts into fuzz with `--allow-partial` / `--best-effort-bodies`.
- **Target precedence** — within a scope, mutually exclusive selectors hard-reject (`target_conflict`). Agent picks one.

When the agent's recovery depends on knowing what happened, hiding the lever steals their ability to recover.

## When in doubt

Three questions:

1. **Does this thing's default depend on the site, or is it uniform?** Uniform → hide. Per-site → expose.
2. **Does the agent's next step change depending on which path was taken?** Yes → expose. No → hide.
3. **If we silently fall back, can the agent tell from the result that we did?** Yes (via `partial: true` etc.) → fine to fall back when opted in. No → never fall back silently.

That's the whole philosophy. Truth > polish, primitives > smart wrappers, defaults only for the obvious, opt-in for everything else.

## What this is NOT

- It's not "expose every CDP command." We're picking up the lever from CDP and presenting it as a verb the agent thinks in. There IS a curation step.
- It's not "make the agent do all the work." Convenience wrappers are good when they don't lie. `screencast stop --gif` is fine because it tells the truth about ffmpeg.
- It's not "no defaults." Sensible defaults are good. Hidden levers with no opt-out are bad.

## Related docs

- [`docs/clicking-strategies.md`](./clicking-strategies.md) — the taxonomy of click verbs.
- [`docs/recording.md`](./recording.md) — screencast vs screenshot, when each applies.
- [`docs/boundaries.md`](./boundaries.md) — what's in scope for chrome-relay vs what we punt to other tools.
