# Error reference

> Every failure is a closed-set code with structured details. Branch on the code, never regex the message.


Every failure prints a human line plus a machine block on stderr, and exits 1:

```json
{ "relayError": {
    "code": "stale_ref",
    "message": "chrome_click_element: @e19 is not a known ref (...). Re-run `chrome-relay snapshot` and use a fresh ref.",
    "tool": "chrome_click_element",
    "phase": "resolve_ref",
    "details": { "ref": "e19" },
    "retryable": false } }
```

An agent that gets a string error has to regex-match prose to decide what to do next. A code is mechanical. The set is closed — these are all of them:

## The codes, and what to do about each

| Code | Means | Agent's move |
|---|---|---|
| `stale_ref` | The @ref's element is gone — navigation killed it, or the node vanished and no same-role/name replacement exists | Re-run `snapshot`, use a fresh ref. Never retry the old one |
| `click_intercepted` | The ref resolved, but an overlay / sticky header / modal owns the click point. The click was NOT delivered | Read `details.interceptor`, dismiss it (close the modal, scroll), retry |
| `element_not_found` | CSS selector matched nothing, or matched a zero-size/unfocusable element | Check the selector against a fresh `snapshot`; or switch to refs |
| `target_conflict` | Two targeting modes at once (`--tab` + `--workspace`, or a ref + `--tab` pointing elsewhere) | Drop one. Refs need no target at all |
| `target_not_found` | The tab/workspace/group doesn't exist (closed, typo) | `chrome-relay tabs` to re-orient |
| `invalid_arguments` | Malformed input: bad CSS syntax, x-without-y, wrong types | Fix the call — the message names the field |
| `timeout` | The operation outran its deadline | Usually the page is slow — check `console`/`network`, then retry once |
| `cdp_error` | Chrome's debugger protocol refused (e.g. attaching to a `chrome://` page) | Some surfaces are off-limits to CDP; work in a normal tab |
| `chrome_api_error` | A `chrome.*` extension API failed | Read the message; often a transient tab state |
| `extension_not_connected` | The extension isn't installed/connected to the host | `chrome-relay doctor`, [installation](/docs/installation/) |
| `native_host_disconnected` | The bridge process died mid-call | Retry once — Chrome respawns the host on demand |
| `external_dependency_missing` | A system tool the command needs is absent (e.g. ffmpeg for `--gif`) | Install it, or pass the documented skip flag |
| `partial_success_disallowed` | A multi-target operation could only partially apply, and you didn't opt into that | Pass `--allow-partial` if partial is acceptable; otherwise fix the failing target |
| `unsupported_tool` | The extension doesn't know this tool — it's older than the CLI | Update the extension (`chrome://extensions` → Update) |
| `internal_error` | A bug — something threw outside the closed set | Worth reporting. By design this should be unreachable from normal agent mistakes |

## Notices (non-fatal, stderr)

| Notice | Means |
|---|---|
| `deprecated` | You used `read`/`ax`/`click-ax` — they work, but switch to `snapshot`/refs |
| `target_overridden` | A subcommand-level target overrode a program-level one |
| `cli_outdated` / `extension_outdated` | Version skew across the bridge — run `chrome-relay update` or update the extension |

## The design rule behind this

No silent partial success, no auto-fallbacks, no "click failed" without saying which of the five things that could mean. The error is the diagnosis: `stale_ref` tells you the page moved on, `click_intercepted` hands you the interceptor's tag and node id, `invalid_arguments` names the field. An agent transcript containing the error should already contain the fix.
