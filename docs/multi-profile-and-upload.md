# Multi-profile + file upload

Design doc for two missing capabilities. Both follow [`cli-philosophy.md`](./cli-philosophy.md): precise primitives, strict by default, no silent fallback, truth in every result.

Revised after adversarial review (2026-07-14). The review's findings are folded in throughout; the decision log at the bottom records what changed and why.

---

## Part 1 — Multi-profile

### Today's behavior is undefined

Chrome spawns **one native host per extension instance**, i.e. per profile. Every host tries to bind the single fixed port `12122`. With two profiles running the extension, the first host wins the port and the second sits dead. Which profile the CLI talks to depends on launch order. This is exactly the "silent fallback to the first thing we found" failure the philosophy forbids — the agent thinks it's clicking in profile A and may be clicking in profile B.

### The model

`profile` becomes the top-level addressing scope:

```
tab ∈ group ∈ workspace ∈ profile
```

Tab IDs, workspace bindings, group bindings, and **ref maps** all live inside one profile's extension. They are meaningless across profiles. So `--profile` **composes with** the existing target flags rather than conflicting with them:

```
chrome-relay --profile work --workspace bidsmith-h01 screenshot -o out.png
chrome-relay --profile personal tabs
```

The intra-scope conflict rules for `--tab`/`--workspace`/`--group` are unchanged; `--profile` is a parent qualifier on all of them.

### Refs become profile-qualified

Today's ref map ([`refs.ts`](../apps/extension/src/browser/refs.ts)) is browser-wide *within one extension instance*: every ref carries its tab identity, which is what makes bare `click @e12` tab-safe. Multi-profile breaks that silently — every profile mints its own `@e1, @e2, …` from its own counter, so cross-profile collisions are the **normal case**, not an edge case, and a bare `@e12` with two profiles connected is unrouteable.

Refs must carry their profile the same way they already carry their tab: **in the printable token itself**, because every CLI invocation is stateless.

```
@3f2a:e12
```

- The **extension mints refs already qualified** with the first 4 hex chars of its own instanceId. No CLI-side token rewriting — display and resolution can never drift apart.
- **Always qualified**, even when one profile is connected. A token whose format depends on how many profiles happen to be running is hidden state. Uniform output, stateless resolution.
- Resolution: the prefix routes the call before any extension is contacted. Bare `@e12` stays accepted under the same rule as any unscoped command — routes with one profile connected, hard-fails `profile_ambiguous` with two.
- `--profile` alongside a qualified ref: allowed when they **agree** (the ref prefix prefix-matches the resolved profile's instanceId), `target_conflict` when they don't:

  ```
  chrome-relay click @3f2a:e12                      # routes by prefix
  chrome-relay --profile work click @3f2a:e12        # ok iff work = 3f2a…
  chrome-relay --profile personal click @3f2a:e12    # target_conflict
  ```

- Multiple refs in one command with different prefixes → `target_conflict`.
- Two connected instances sharing a 4-char prefix (astronomically rare, but specified): qualified ref → `profile_ambiguous` listing full instanceIds; disambiguate with an agreeing `--profile <longer-prefix>`.

### Identity: minted, not discovered

An extension cannot read its own profile's name or directory — Chrome doesn't expose it. So identity is minted:

- On install, the extension generates a stable **`instanceId`** (UUID) in `chrome.storage.local`. Per-profile by construction. Survives restarts; dies with profile removal or extension reinstall.
- **Labels live in a CLI-owned persistent registry**, not in the extension:

  ```
  ~/.chrome-relay/labels.json
  { "instances": { "3f2a…": { "label": "work" }, "91bc…": { "label": "personal" } } }
  ```

  Aliases are an addressing concern; addressing lives CLI-side. This is also the only place uniqueness is *enforceable* — extension-stored labels can't see each other, so a disconnect → relabel → reconnect sequence would mint duplicates that no one could detect. Live descriptors describe connections; the persistent registry owns aliases.

  ```
  chrome-relay profile label work            # one profile connected: implicit target
  chrome-relay --profile 3f2a profile label work   # multiple connected: target by id prefix
  ```

- `bridge.ready` carries `{ instanceId }`. Optionally an `email` hint from `chrome.identity.getProfileUserInfo` — shown in `profile list`, **never an address** (it changes on sign-out; addresses must be stable).

Labels are unique in the registry; labeling with a taken name fails `label_conflict`. Unlabeled profiles are addressable by instanceId prefix (`--profile 3f2a`) — nothing is ever unreachable. `profile list` marks them `(unlabeled)`.

Consequence, on record: labels live on this machine, not in the profile. Wiping `~/.chrome-relay` loses them; instanceIds survive, so recovery is one `profile label` per profile.

### Discovery: registry files; the handshake is the authority

Each native host binds an **ephemeral port** (`listen(0)`) and writes a descriptor:

```
~/.chrome-relay/instances/<instanceId>.json
{
  "schemaVersion": 1,
  "instanceId": "3f2a…",
  "generationId": "e879…",
  "port": 61423,
  "token": "…",
  "pid": 71182,
  "extensionVersion": "0.7.4",
  "hostVersion": "0.7.4",
  "protocolVersion": 2,
  "startedAt": "…"
}
```

Lifecycle rules (each closes a real race):

- **Atomic writes**: temp file + rename. A reader never sees a torn descriptor.
- **`generationId`**: fresh UUID per host process. A host deletes its descriptor on exit **only if the on-disk generationId is still its own** — otherwise an old host exiting late would delete the descriptor of the newer host that replaced it.
- **PID is a hint, the ping is the authority.** PIDs get reused; "pid exists" proves nothing. The CLI's `/ping` handshake returns `{ instanceId, generationId, protocolVersion, extensionVersion }` and the CLI verifies the echoed instanceId matches the descriptor before trusting the port — a reused port can't impersonate a profile.
- **Stale descriptors** (dead pid *and* failed ping, or ping echoing a different instanceId) are deleted by the CLI as it discovers them. Self-healing, no daemon.
- **`token`**: unguessable per-generation bearer token; the CLI sends it on every `/call`, the host rejects requests without it. Defense-in-depth beside the existing browser-origin rejection — the descriptor file is `0600`, so possession proves local file access. Directory `0700`.
- Paths resolve per-platform (`os.homedir()`-based on macOS/Linux, `%LOCALAPPDATA%\chrome-relay` on Windows) — the doc writes `~/.chrome-relay` as shorthand.

**The registry is discovery; the handshake is authority.** The descriptor gets the CLI to a port; the handshake proves who's on it.

No `capabilities` array in the descriptor: capabilities are derivable from the versions, and machine-readable release notes (philosophy §7) are already the capability channel. One source of truth.

**Rejected: port-range scanning.** Slow, collides with unrelated software, and a port tells you nothing about which profile answered without a handshake anyway.

**Back-compat:** for one minor release the first host to launch also binds `12122` so old CLIs keep working. Then the fixed port dies.

### Routing strictness

| Connected profiles | Unscoped command (no `--profile`, bare or no ref) |
|---|---|
| 0 | `extension_not_connected` (unchanged) |
| 1 | Routes to it. Uniform, obviously-right default → hidden, per philosophy §2. |
| ≥2 | **Hard fail `profile_ambiguous`**, details enumerate candidates (label, id prefix, email hint). Never pick one. |

`--profile <name>` matches label first, then instanceId prefix. No match → `profile_not_found` listing what *is* connected. Ambiguous prefix → `profile_ambiguous`.

Strictness is on **present state only**: one profile connected now routes implicitly even if the registry saw a second profile an hour ago. Present state is checkable; history is spooky.

### Results say where they ran — once routing succeeded

The invariant: **every result after successful routing identifies the exact profile; routing failures enumerate candidates instead.** (A routing failure *has* no resolved profile to stamp — the candidate list is the actionable truth for that case.)

Post-routing, success and failure alike:

```json
{ "ok": true,  "profile": { "label": "work", "instanceId": "3f2a…" }, "data": … }
{ "ok": false, "profile": { "label": "work", "instanceId": "3f2a…" },
  "errorDetails": { "code": "element_not_found", … } }
```

Routing failure:

```json
{ "ok": false,
  "errorDetails": { "code": "profile_ambiguous",
    "details": { "candidates": [
      { "instanceId": "3f2a…", "label": "work" },
      { "instanceId": "91bc…", "label": null, "email": "k@…" } ] } } }
```

A transcript can never be ambiguous about where a click landed, and a routing failure always carries what the agent needs to retry scoped.

### New surface

```
chrome-relay profile list            # connected profiles: label, id, email hint, port, versions
chrome-relay profile label <name>    # bind/rebind the label of the targeted profile (CLI registry)
chrome-relay --profile <label|idprefix> <any command>
@<idprefix>:<ref>                    # profile-qualified ref token, minted by the extension
```

New error codes (closed set, `packages/protocol`): `profile_ambiguous`, `profile_not_found`, `label_conflict`.

**Rejected: a default-profile config file.** Persistent config changes routing invisibly between transcript lines. An agent reading its transcript could no longer tell where a command went. Everything stays in the invocation or in the (stamped) result.

---

## Part 2 — File upload

No upload support exists today. It can't be one verb: real sites take files through three genuinely different mechanisms, each with its own failure mode. Same reasoning as [`clicking-strategies.md`](./clicking-strategies.md) — expose the strategies as verbs, the agent picks, the failure names the strategy.

**All three verbs take paths, not bytes.** Chrome reads the files itself (`DOM.setFileInputFiles` and `Input.dispatchDragEvent` both accept filesystem paths), so nothing crosses the bridge and there is no size cap anywhere.

### Precondition: file access for the extension

Chrome gates debugger file operations behind the user-controlled **"Allow access to file URLs"** toggle — an upload that works on one machine fails on another with an opaque CDP error if the toggle is off. This is the worst failure shape, so it's handled structurally:

- `chrome-relay doctor` checks `chrome.extension.isAllowedFileSchemeAccess()` and reports it.
- Upload verbs fail with **`file_access_denied`** carrying exact remediation: *"chrome://extensions → Chrome Relay → enable 'Allow access to file URLs', then retry."*
- Development gate: a real upload smoke test through `chrome.debugger` (not Puppeteer, where everything works). Manifest inspection proves nothing.

### `upload set` — the input is right there

```
chrome-relay upload set --tab 123 --ref @3f2a:e12 --file ./cv.pdf [--file more.png]
```

Direct `DOM.setFileInputFiles` on a resolved `<input type="file">`. Target by `--ref` or `--selector`, same mutual-exclusion rules as click.

- Node isn't a file input → `not_a_file_input`. That's the signal to try `choose`.
- More than one `--file` against an input without `multiple` → `multiple_not_supported`. Hard fail; site behavior would be undefined.
- `accept` attribute mismatch → **notice** (`accept_mismatch`), not a failure. Sites lie about accept.

### `upload choose` — the input is hidden behind a button

The common modern case: styled button, hidden or shadow-DOM or created-on-click input, click opens the OS picker. Sequence, atomic in one verb:

1. `Page.enable`, then arm `Page.setInterceptFileChooserDialog` — **before** clicking. Interception is what suppresses the native OS dialog; without it the click pops a file picker on the user's screen, the single most focus-stealing thing chrome-relay could do.
2. Click the trigger (`--click-ref` / `--click-selector`), through the normal click path — same hit-testing, same failure codes.
3. Catch `Page.fileChooserOpened`, **matched to this tab's debugger session** — never a global listener that could catch another tab's chooser.
4. Set files on the intercepted node. 5. Disarm, always (finally-semantics).

```
chrome-relay upload choose --tab 123 --click-ref @3f2a:e4 --file ./cv.pdf
```

Concurrency and lifecycle rules:

- **Interception is serialized per tab.** A second `choose` while one is armed fails immediately with `file_chooser_busy` — two concurrent calls would otherwise disarm each other in their `finally` blocks.
- No `fileChooserOpened` within timeout → `no_file_chooser` ("the click did not open a file dialog — wrong trigger, or the site uses a drop zone; try `upload set` on a hidden input or `upload drop`").
- Event arrives **without `backendNodeId`** (guaranteed only for choosers opened from a real file input) → **`file_chooser_unsupported`** — a *distinct* code from `no_file_chooser`, because the agent's next move differs: a chooser opened but this strategy can't drive it, vs. no chooser opened at all.
- OOPIF file inputs: v1 is top-frame and same-process frames; an OOPIF chooser → `file_chooser_unsupported`. Extend if a real site class demands it.
- Navigation or tab close while armed → disarm, fail `target_closed`.
- The event's `mode` (`selectSingle`/`selectMultiple`) enforces the multi-file check with ground truth instead of attribute-sniffing.

### `upload drop` — no input exists at all

Drop zones whose JS reads `DataTransfer` from a drop event.

```
chrome-relay upload drop --tab 123 --ref @3f2a:e7 --file ./avatar.png
```

Primary mechanism — **paths, no bytes**: resolve the target's center, then

```
Input.dispatchDragEvent(type=dragEnter, data.files=[paths…])
Input.dispatchDragEvent(type=dragOver,  data.files=[paths…])
Input.dispatchDragEvent(type=drop,      data.files=[paths…])
```

`DragData.files` takes filesystem paths — Chrome reads the files exactly as `setFileInputFiles` does. Same trust model, no size cap.

Caveat, and the gate on it: `Input.dispatchDragEvent` is **experimental CDP**, and file-touching debugger methods are exactly the class Chrome gates behind file access (see above). The mechanism ships only after the smoke test passes on real drop-zone sites **through `chrome.debugger`**. Contingency if it fails there: page-side `File` construction from bytes over the bridge (native messaging caps host→extension at ~1 MB, so that path is chunked or capped) — kept out of v1 unless the primary path is proven broken.

Result reports `dropHandled` (was `preventDefault` called — i.e., did a handler exist), because that's what's *observable*. Whether the app accepted the file is app state; the agent verifies via snapshot, same as after any click.

### Cross-cutting rules

- CLI `stat`s every `--file` locally before anything goes over the wire → `file_not_found` fails fast with the resolved absolute path. Relative paths resolve against cwd and the result echoes the resolution.
- **Verified results, not assumed:** after `set`/`choose`, read back `input.files` and return what the input actually holds:

  ```json
  { "ok": true, "profile": { "label": "work", "instanceId": "3f2a…" },
    "files": [{ "name": "cv.pdf", "size": 48211, "type": "application/pdf" }],
    "input": { "multiple": false, "accept": ".pdf,.doc" } }
  ```

- Boundary note: paths come only from the invoking agent's command line. The extension never enumerates or browses the filesystem; every mechanism hands Chrome a path the agent already had the right to read.

New error codes: `not_a_file_input`, `no_file_chooser`, `file_chooser_busy`, `file_chooser_unsupported`, `file_access_denied`, `multiple_not_supported`, `file_not_found`, `target_closed`. New notice: `accept_mismatch`.

Downloads are the sibling capability and stay out of scope here.

---

## Decision log

Original decisions (round 1):

1. **Registry files over port scanning** for discovery.
2. **Ephemeral ports + one release of `12122` back-compat**, then the fixed port dies.
3. **Unlabeled profiles addressable by id prefix** — nothing unreachable, but `profile list` nags.
4. **Single connected profile routes implicitly**; two+ hard-fails `profile_ambiguous`.
5. **No default-profile config file** — invisible routing state breaks transcript-debuggability.
6. **Three upload verbs, no auto-fallback** — failure names the strategy.

Revised after review (round 2, 2026-07-14):

7. **Refs are profile-qualified in the printable token** (`@3f2a:e12`), minted by the extension, **always** — even single-profile. The review showed bare refs become unrouteable across profiles (colliding counters are the normal case); a format that varies with connected-profile count would be hidden state. Supersedes nothing — this was a hole, not a decision.
8. **Labels move to a CLI-owned persistent registry** (`labels.json`). Extension-stored labels made the uniqueness invariant unenforceable (disconnect → relabel → reconnect mints undetectable duplicates). Supersedes the round-1 extension-storage design.
9. **Registry lifecycle hardened**: atomic writes, generationId-guarded cleanup, ping-echoes-instanceId as the authority over PID, per-generation bearer token, `0600`/`0700` perms. *Trimmed:* no `capabilities` array — versions + machine-readable release notes are already the capability channel.
10. **Envelope invariant refined**: profile stamp on every result *after successful routing*; routing failures enumerate candidates instead. The round-1 claim ("every error stamped") was impossible for errors that exist because no profile resolved.
11. **`upload drop` redesigned around `Input.dispatchDragEvent` with path-based `DragData.files`** — no bytes over the bridge, no size cap. The round-1 byte-shipping design (512 KB cap) solved a constraint the path route doesn't have; byte-injection is demoted to a contingency gated on the chrome.debugger smoke test failing.
12. **File-URL access handled structurally**: doctor check + `file_access_denied` + remediation text. The toggle-off failure mode is otherwise an opaque CDP error on someone else's machine.
13. **`upload choose` concurrency spec'd**: per-tab serialization (`file_chooser_busy`), session-scoped event matching, `file_chooser_unsupported` as a distinct code from `no_file_chooser` (different agent recovery), OOPIF unsupported in v1, `target_closed` on nav/close while armed.

## Rollout

Protocol bump (new tool names `chrome_profile`, `chrome_upload`; envelope `profile` field; qualified ref token format; new error codes). Extension and CLI ship together; `chrome-relay update` release notes carry the new verbs as structured entries per philosophy §7. Multi-profile lands first — upload is per-profile-agnostic and works either side of it, but qualified refs in upload examples assume the ref-format change has landed.
