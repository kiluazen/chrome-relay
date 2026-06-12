# Codex Chrome Extension vs chrome-relay: Real-Browser Agent-Control Analysis

Status: analysis artifact.  
Date: 2026-06-12.  
Scope: live read-only tests against the user's authenticated Chrome session, with Cloudflare Dashboard as the primary stress target and Google Cloud Console as a secondary stress target.

## Executive summary

The correct comparison is **Codex Chrome Extension vs chrome-relay**, not the Codex in-app Browser vs chrome-relay.

The Codex Chrome Extension can absolutely operate the real authenticated Chrome session. In the Cloudflare Dashboard test it navigated the real logged-in dashboard, opened Security Insights, opened a first-row Details drawer, used Quick Search to reach Audit Logs, and read the Pages metrics dashboard. Therefore the adoption story should **not** claim that chrome-relay uniquely enables authenticated Chrome automation.

The stronger and more accurate claim is:

> chrome-relay turns real-Chrome automation into a compact, terminal-native, ref-oriented, background-safe, DevTools-aware agent loop. It is not merely a performance optimization. It changes the operating model from an in-process browser API to a reusable CLI/protocol surface that any agent, script, or shell workflow can drive.

Confidence: **high** for Cloudflare behavior and tool-surface differences, because both systems were tested live. Confidence: **moderate** for Google Cloud Console comparison, because chrome-relay was tested live there but the Codex Chrome Extension connection dropped transiently during the GCP probe.

## What was tested

Primary target:

```text
https://dash.cloudflare.com/<account-id>/home/overview
```

Secondary target:

```text
https://console.cloud.google.com/welcome?project=<project-id>&authuser=1
```

Sensitive account IDs, project IDs, auth headers, cookies, and network tokens should be treated as private. The raw test captured some privileged browser state locally, but this document intentionally does not reproduce tokens, cookies, or auth headers.

Local evidence directory:

```text
/tmp/codex-chrome-vs-chrome-relay-20260612123611
```

Representative captured files:

```text
codex_chrome_overview_domSnapshot.txt
codex_chrome_security_details_domSnapshot.txt
codex_chrome_audit_logs_domSnapshot.txt
codex_chrome_pages_metrics_domSnapshot_retry.txt
chrome_relay_overview_snapshot_interactive.txt
chrome_relay_security_details_snapshot_interactive.txt
chrome_relay_audit_logs_snapshot.txt
chrome_relay_pages_metrics_snapshot_full.txt
chrome_relay_gcp_welcome_snapshot_interactive.txt
```

## The most important correction

The Codex Chrome Extension is not equivalent to the Codex in-app Browser.

The in-app Browser is a separate browser surface. It does not necessarily share the user's Chrome cookies, extensions, profile, or logged-in dashboard state. That is why an in-app Browser comparison can fail on login/human-check surfaces and still say almost nothing about the Codex Chrome Extension.

The Codex Chrome Extension is the real comparison point because it controls the user's actual Chrome profile. In the tested setup it reached the same authenticated Cloudflare Dashboard that chrome-relay reached.

## Tool-surface comparison

| Dimension | Codex Chrome Extension | chrome-relay |
|---|---|---|
| Browser state | Real user Chrome session | Real user Chrome session |
| Primary interface | Codex plugin API through JavaScript runtime | Terminal CLI plus local bridge plus extension |
| Basic page read | `tab.playwright.domSnapshot()` and `tab.dom_cua.get_visible_dom()` | `chrome-relay snapshot`, `snapshot -i`, `snapshot --json` |
| Action model | Playwright-style locators, DOM CUA node IDs, coordinate CUA | `@ref` handles, CSS selectors, coordinates |
| Command composition | Inside Codex runtime/session | Shell-native: pipe, redirect, script, batchable |
| DevTools console | `tab.dev.logs()` | `chrome-relay console` |
| DevTools network | No comparable network API observed in exposed docs | `chrome-relay network`, `network read` |
| Screenshots | `tab.screenshot()` returns bytes | `chrome-relay screenshot -o file.png` |
| JS evaluation | `tab.playwright.evaluate()` read-only page scope | `chrome-relay js` in page main world |
| Tab targeting | Browser API objects and claimed tabs | Explicit `--tab`, workspaces, groups, and ref-carried tab identity |
| Best fit | Codex-native browser work with locator semantics | CLI-first multi-agent/browser automation, debugging, reproducible probes |

## Input/output-level difference

This is the key product distinction.

### Codex Chrome Extension

The Codex Chrome Extension presents a rich browser-control API inside Codex:

```js
await tab.playwright.domSnapshot()
await tab.dom_cua.get_visible_dom()
await tab.playwright.getByRole("button", { name: "Quick search...", exact: true }).click({})
await tab.screenshot({ fullPage: false })
await tab.dev.logs({ limit: 50 })
```

That is powerful when the agent is already inside Codex and can keep JavaScript objects alive. It feels like a constrained Playwright/CUA hybrid. The downside is that the workflow is less portable: another shell script, another local agent, or a non-Codex automation process cannot trivially reuse the same API unless it is also wired into the plugin runtime.

The output also tends to be API-shaped rather than shell-shaped. You get snapshots, JSON-ish visible DOM, byte arrays for screenshots, and runtime objects. That is fine for Codex, but it is not as naturally inspectable or composable from the terminal.

### chrome-relay

chrome-relay presents real-Chrome automation as a CLI:

```sh
chrome-relay tabs
chrome-relay snapshot -i --tab 123
chrome-relay click @e147
chrome-relay keys --tab 123 Cmd+K
chrome-relay type --tab 123 "audit logs"
chrome-relay screenshot --tab 123 -o /tmp/evidence.png
chrome-relay network --tab 123
```

The output is deliberately agent-readable text:

```text
- button "Quick search..." [ref=e121]
- link "Security insights Info 16 12 high, 4 low" [ref=e147]
- combobox "Search products, pages, and features…" [expanded, ref=e2]: audit logs
- option "Audit logs" [selected, ref=e5]
```

That is the dramatic change. The browser is no longer just a tool available inside one model runtime. It becomes a small local protocol any agent can call, test, redirect to files, diff, or compose with shell tooling.

## Cloudflare stress test

Cloudflare Dashboard is a strong benchmark because it is authenticated, SPA-heavy, side-nav-heavy, virtualized-table-heavy, and contains command palettes, drawers, charts, modals, and account-sensitive controls.

### Test path

The tested read-only path was:

1. Open account overview.
2. Read top-level analytics cards and dashboard sections.
3. Navigate to Security Insights.
4. Open the first visible Details drawer.
5. Extract the issue title, risk, detection method, and recommendation.
6. Use Quick Search / command palette to search for `audit logs`.
7. Press Enter to navigate to Audit Logs.
8. Read the audit table surface.
9. Navigate to the `chrome-relay` Pages project metrics page.
10. Read metrics and Web Analytics state.

### Codex Chrome Extension result

The Codex Chrome Extension succeeded on the Cloudflare path.

Observed overview metrics:

| Read/action | Result |
|---|---:|
| `domSnapshot()` | 21,432 bytes, 425 ms |
| `dom_cua.get_visible_dom()` | 11,740 bytes, 23 ms |
| targeted `evaluate()` | 1,657 bytes, 14 ms |
| screenshot | 95,790 bytes, 68 ms |
| dev logs | 0 entries, 6 ms |

Security Insights behavior:

- The extension found three matching `/security-center` links.
- This required explicit disambiguation: the visible analytics-card link was the third match.
- Navigation to Security Insights succeeded.
- The page exposed 32 `Details` buttons.
- The first row Details drawer opened successfully.
- The drawer exposed the issue content: an “Always Use HTTPS” configuration issue, its risk, detection method, and recommended action.

Command-palette behavior:

- Clicking the visible Quick Search button did not immediately expose the command-palette input in the first attempt.
- `Cmd+K` did expose the command-palette input.
- The exact placeholder contained a real Unicode ellipsis: `Search products, pages, and features…`.
- Filling `audit logs` and pressing Enter navigated to `/audit-log`.

Pages metrics behavior:

- The first metrics read hit a cookie-preference/modal state and produced an alert-only snapshot.
- After the UI settled/dismissed, the actual Pages metrics view was readable.
- It showed the `chrome-relay` Pages project metrics surface, including zero request/error/subrequest values in the selected time range and Web Analytics disabled.

Conclusion: Codex Chrome Extension is capable. The honest critique is not capability; it is ergonomics, portability, output compactness, and debugging surface.

### chrome-relay result

chrome-relay also succeeded on the Cloudflare path.

Observed overview output sizes:

| Read/action | Result |
|---|---:|
| `snapshot -i` | 4,950 bytes, about 0.39 s |
| full text `snapshot` | 8,604 bytes, about 0.44 s |
| `snapshot --json` | 49,191 bytes, about 0.41 s |
| JS projection | 1,600-ish bytes, about 0.32 s |

Security Insights behavior:

- The overview snapshot exposed the Security Insights card as a direct actionable ref:

```text
link "Security insights Info 16 12 high, 4 low" [ref=e147]
```

- `chrome-relay click @e147` navigated to Security Insights.
- The first Details button was exposed as a direct ref.
- `chrome-relay click @e314` opened the drawer.
- The drawer snapshot exposed the dialog and controls:

```text
dialog "Resolve insight" [ref=e523]
heading "audience..." [level=3]
heading "“Always use HTTPS” not enabled" [level=3]
heading "Risk" [level=3]
heading "Detection method" [level=3]
heading "Recommended actions" [level=3]
link "Manage in the SSL/TLS App" [ref=e533]
button "Archive insight" [ref=e534]
```

Command-palette behavior:

```sh
chrome-relay keys --tab <tab> Cmd+K
chrome-relay type --tab <tab> "audit logs"
chrome-relay snapshot -i --tab <tab>
```

The command-palette snapshot was only 393 bytes and contained exactly what the agent needed:

```text
- button "Dismiss" [ref=e1]
- combobox "Search products, pages, and features…" [expanded, ref=e2]: audit logs
- button "Esc" [ref=e3]
- listbox [ref=e4]
  - option "Audit logs" [selected, ref=e5]
  - option "Ask AI — \"audit logs\"" [ref=e6]
```

Pressing Enter navigated to `/audit-log`.

Audit Logs behavior:

- The audit table came back as a large virtualized list of clickable row refs.
- This is a good stress result: the rows were actionable and visible to the agent loop.
- It also shows a potential data-volume issue: audit logs can leak account activity into snapshots if agents dump them carelessly.

Pages metrics behavior:

- `snapshot -i` was extremely compact but omitted many non-interactive metric values.
- Full `snapshot` included values like Requests, Success, Errors, Subrequests, CPU percentile labels, and Web Analytics state.
- This is an important tradeoff: `-i` is best for acting; full snapshot or JS projection is better for factual extraction.

## Google Cloud Console stress test

Google Cloud Console is another strong target because it has complex app chrome, modals, a search surface, project switchers, account menus, Cloud Shell, notifications, and product navigation.

chrome-relay loaded the GCP welcome page successfully. It saw:

- free-trial dialog
- project switcher
- global searchbox
- Google Cloud home link
- Gemini Cloud Assist button
- Cloud Shell button
- notifications
- account menu
- project number and project ID copy buttons
- Dashboard and Cloud Hub links
- Quick Access links: APIs and services, IAM and admin, Billing, Compute Engine, Cloud Storage, BigQuery, VPC network, Kubernetes Engine

The interactive snapshot was 2,648 bytes. The full snapshot was 4,245 bytes. A JS text projection was 1,424 bytes.

The Codex Chrome Extension GCP test was inconclusive in this run. After the Cloudflare probes, the extension connection reported a transient `native pipe is closed` error. Local setup checks showed Chrome running, the Codex Chrome Extension installed and enabled, and the native host manifest correct. Finalization later succeeded, so this should be treated as a transient connection failure rather than proof that the extension cannot handle GCP Console.

Conclusion: chrome-relay passed the live GCP probe. Codex Chrome Extension probably can handle GCP Console too, but this run does not prove it.

## Output-size comparison

Measured local artifact sizes:

| Scenario | Codex Chrome Extension | chrome-relay |
|---|---:|---:|
| Cloudflare overview, rich DOM | 21,432 bytes | 4,950 bytes with `snapshot -i`; 8,604 bytes full text |
| Cloudflare overview, visible/action DOM | 11,740 bytes | 4,950 bytes with `snapshot -i` |
| Security Details drawer | 31,036 bytes | 11,471 bytes |
| Audit Logs | 16,853 bytes | 13,477 bytes |
| Pages metrics | 18,334 bytes | 6,585 bytes full text |
| GCP Console welcome | inconclusive for extension | 2,648 bytes interactive |

Interpretation:

- chrome-relay is usually more token-efficient for agent loops.
- Codex Chrome Extension is not unusably large; it is simply more verbose.
- chrome-relay `snapshot -i` is excellent for acting but can hide non-interactive facts.
- chrome-relay full snapshot or JS projection should be used for factual extraction.
- `snapshot --json` can be much larger than text output and should not be the default thing pasted into model context.

## Images and screenshots

Both systems can receive images/screenshots, but the ergonomics differ.

Codex Chrome Extension:

- `tab.screenshot()` returns image bytes to the Codex runtime.
- The model/tooling can save or emit those bytes.
- This is convenient inside Codex but less CLI-native.

chrome-relay:

- `chrome-relay screenshot --tab <id> -o /tmp/file.png` writes a PNG file.
- This is directly shell-friendly and easy to attach to issue reports or regression artifacts.
- It supports the mental model of “capture proof, then inspect/share the file.”

Neither screenshot path replaces DOM/snapshot reads. Screenshots are best for chart/canvas/SVG-heavy surfaces, visual regressions, layout issues, overlays, and cases where accessible structure omits important visual state.

## DevTools and network exposure

This is one of chrome-relay's clearest wins.

Codex Chrome Extension exposed:

- console logs via `tab.dev.logs()`
- read-only Playwright-style evaluate
- DOM snapshots
- screenshots
- page assets capability

chrome-relay exposed:

- console ring buffer
- network ring buffer
- request/response metadata
- network body reads
- JS evaluation in the page main world
- screenshots
- viewport control
- tab/workspace/group management

The live Cloudflare Pages metrics navigation captured GraphQL requests through chrome-relay's network surface. That is operationally valuable because it lets an agent answer:

- Which endpoint fired?
- Did it return 200?
- How long did headers take?
- Was it served from disk cache or service worker?
- What were response headers and content types?
- What request IDs can be inspected further?

But it is also the largest safety risk. The network output included sensitive request headers. Any spec or skill that promotes `chrome-relay network` must also say:

```text
Never paste raw network output into chat, docs, issues, or logs without redacting cookies, auth headers, csrf/atok-style headers, tokens, account IDs, project IDs, and private URLs.
```

## What chrome-relay enables that is not just performance

The adoption spec should not sell the work as “faster snapshots” only. That understates it.

The meaningful new capabilities are:

1. **Terminal-native real-browser control**
   - Any agent or script can drive the user's real Chrome session without being embedded in the Codex plugin runtime.

2. **Actionable refs as a first-class contract**
   - `snapshot -> click @e147 -> snapshot` is a cleaner loop than carrying CSS selectors, coordinates, or Playwright locator objects.

3. **Ref-carried tab identity**
   - A ref can encode the tab it came from, reducing wrong-tab risks when the user changes focus.

4. **Background operation**
   - chrome-relay's product thesis is backgrounded CDP control without stealing user focus.

5. **DevTools-level debugging**
   - Network and console access make chrome-relay useful for diagnosing real app behavior, not just clicking around.

6. **Shell composability**
   - Output can be redirected to files, grepped, diffed, checked into artifacts, and used by non-Codex tooling.

7. **Multi-agent/workspace ergonomics**
   - Workspaces and groups let multiple agents isolate browser work better than “whatever tab is active.”

8. **Snapshot mode selection**
   - `snapshot -i` for action loops.
   - full `snapshot` for factual reads.
   - `snapshot --json` for machine handling.
   - `js` for targeted extraction.

These are product-surface changes, not just performance improvements.

## Where Codex Chrome Extension is still better or competitive

The Codex Chrome Extension remains strong in several areas:

1. **Codex-native integration**
   - The API is directly available to the Codex agent once connected.

2. **Locator semantics**
   - Playwright-style locators are expressive when the DOM has stable roles, labels, test IDs, or hrefs.

3. **DOM CUA**
   - `get_visible_dom()` exposes node IDs for interactable visible elements and is fast.

4. **Structured API**
   - For a model already operating inside Codex, typed methods can be clearer than shell strings.

5. **No separate CLI dependency**
   - The user does not need to learn or call `chrome-relay` commands directly.

6. **Safety by narrower surface**
   - The absence of exposed raw network capture reduces accidental token/header leakage.

The correct posture is not “replace Codex Chrome Extension.” It is “chrome-relay is a more portable and CLI-native browser-control layer, especially for agent swarms, local scripts, and debugging.”

## Failure modes and rough edges observed

### Codex Chrome Extension

Observed:

- Link duplication required locator disambiguation on Cloudflare Security Insights.
- Command-palette input matching required the exact Unicode ellipsis placeholder.
- A transient native-pipe failure interrupted the GCP probe.

Implication:

- The API is capable, but the agent must be careful with locator uniqueness and connection lifecycle.

### chrome-relay

Observed:

- CLI option ordering mattered for at least one failed `keys` attempt.
- Browser tab IDs changed after the Chrome/extension session refreshed.
- `snapshot -i` was too sparse for some factual metric extraction.
- Network output can expose sensitive headers.

Implication:

- The ref model and snapshots are strong, but docs and skills must teach when to use `-i`, full snapshot, JS, screenshots, and network.
- Error messages and CLI argument parsing should be hardened where possible.
- Sensitive-output redaction must be explicit.

## Recommended positioning

Use this:

> chrome-relay is not valuable because Codex Chrome Extension cannot control real Chrome. It can. chrome-relay is valuable because it gives agents a compact, reusable, terminal-native control plane for the real authenticated browser: refs, snapshots, background tab control, JS, screenshots, console, network, workspaces, and scriptable evidence capture.

Avoid this:

> chrome-relay lets agents use logged-in Chrome, unlike Codex Chrome.

That claim is false.

Better phrasing:

> Both can use logged-in Chrome. chrome-relay packages that capability as a small CLI/protocol surface optimized for agent loops and debugging.

## Recommended spec edits

If this analysis is fed back into `agent-browser-adoption-spec.md` or related docs, I would make these edits:

1. Replace any implication that Codex Chrome Extension cannot operate authenticated Chrome dashboards.
2. Frame the core delta as **loop ergonomics plus protocol portability**, not raw capability.
3. Keep output-size measurements, but separate them into:
   - action-loop payloads
   - factual-read payloads
   - JSON/machine payloads
4. Add a rule: `snapshot -i` is for actions, not complete fact extraction.
5. Add a rule: use full `snapshot`, `get`, or `js` when reading non-interactive values.
6. Add a redaction policy for `network`.
7. Call out that Codex Chrome Extension remains a valid comparison baseline.
8. Make “DevTools/network access” a first-class product reason.
9. Include Cloudflare Dashboard and GCP Console as regression benchmarks.
10. Include command-palette flows as a required benchmark, because focus/keyboard behavior is where agents often fail.

## Copyable feedback to another agent

```text
The comparison should be Codex Chrome Extension vs chrome-relay, not in-app Browser vs chrome-relay.

Codex Chrome Extension can operate the real authenticated Chrome session. In live Cloudflare testing it reached the dashboard overview, navigated to Security Insights, opened a first-row Details drawer, used Quick Search to reach Audit Logs, and read the Pages metrics surface. So do not claim chrome-relay uniquely enables authenticated Chrome automation.

The real chrome-relay advantage is the operating model: a compact CLI/protocol loop for real Chrome. `snapshot -i -> click @ref -> snapshot` is more portable and agent-friendly than a Codex-only Playwright/CUA API. It also exposes console/network/screenshot/JS/viewport/workspace primitives in a shell-native way.

Measured Cloudflare payloads support the ergonomics claim: Codex overview domSnapshot was ~21.4KB; relay overview interactive snapshot was ~4.95KB. Security Details was ~31KB via Codex vs ~11.5KB via relay. Pages metrics was ~18.3KB via Codex vs ~6.6KB via relay full text snapshot.

But relay is not always strictly “better output.” `snapshot -i` can omit non-interactive facts, so agents need to switch to full snapshot or JS for metric extraction. Relay network output is powerful but can leak sensitive auth headers, so redaction needs to be mandatory.

Net: chrome-relay is worth adopting as a CLI-first, compact, background-safe, DevTools-aware browser-control layer. It should be positioned as better loop ergonomics and broader automation/debugging surface, not as basic logged-in browser capability that Codex Chrome lacks.
```

## Final verdict

chrome-relay is a real upgrade if the goal is:

- browser control outside a single Codex runtime
- smaller action-loop context
- reusable refs
- background tabs
- shell/script composition
- network and console debugging
- multi-agent browser workflows
- persistent evidence artifacts

Codex Chrome Extension is already capable for authenticated dashboard work. The chrome-relay adoption argument should be disciplined: **not “new access,” but “better agent control plane.”**

Confidence: **high** for this verdict.
