# Chrome Relay — visibility & user feedback

Grounded in:
- `apps/extension/entrypoints/popup/main.ts` — the popup is read-only status, no feedback UI today
- `landing/public/index.html` — landing page has zero web analytics and a direct Web Store CTA
- `packages/cli/src/program.ts` — CLI has no telemetry/feedback commands today
- `docs/privacy-policy.md` — "Chrome Relay does not send browsing data to a Chrome Relay cloud service" (the line we will not break)
- `docs/boundaries.md` §2 — Web Store dashboard tells us counts, not who or why

This is the *visibility* sibling to `boundaries.md`. Boundaries talks capability; this talks *who's using us and how do we hear from them.*

---

## 1. The current state, factual

| Surface | What it captures today |
| --- | --- |
| Landing page (`landing/public/index.html`) | nothing. No gtag, no Plausible, no Cloudflare Web Analytics — I grepped. |
| "Add to Chrome" button | direct anchor to `chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb`. No funnel. |
| "Contact me" form at page bottom | already wired. POSTs `{product, email, source}` to a Google Apps Script (`script.google.com/.../exec`), lands in a Google Sheet. Optional, ignorable, scrolls below the fold. |
| Chrome Web Store dashboard | aggregate installs / uninstalls / weekly users / ratings. No identity. |
| Extension popup | status block + last 3 tool executions (local-only). No "report issue" link. |
| CLI | no `sayhi`, `report`, `feedback`, or `recommend` command. The closest thing is `chrome-relay doctor`. |
| Privacy policy | explicitly says "no data sent to Chrome Relay cloud service." This is the contract — any new feature has to either keep that promise or be a user-initiated action that the user is clearly choosing. |

So today: I get the Web Store's 17 uninstalls number and nothing else. That's the gap.

---

## 2. What we actually want to learn

In priority:

1. **Are people seeing the landing page?** Right now I'd be guessing at "did the Reddit comment land?" vs "is the page broken in Safari?" because I literally cannot tell.
2. **What's the install conversion?** Web Store gives installs but the page-views denominator is missing.
3. **Who are the early users?** Email addresses so we can DM them, ship them autark/plumcake, get them on a call.
4. **Why did the 17 uninstall?** Some directional read on whether they bounced because the install flow broke vs. because they didn't get the value prop.
5. **What do they want?** Feature requests + bug reports without us forcing them into GitHub issues UX.

The honest tension: (3) and (4) require identity, and the privacy policy says we don't ship identity. So those features are *only* tractable as opt-in user-initiated actions.

---

## 3. The options, ordered by intrusiveness

### Tier 0 — Anonymous landing-page analytics
**Ship today. No privacy-policy change. No PII.**

One `<script>` tag in `landing/public/index.html`. The candidates:

| Tool | Pros | Cons |
| --- | --- | --- |
| **Cloudflare Web Analytics** | free; cookieless; already on CF Pages if the landing's there | minimal UI; no custom events |
| **Plausible** | clean UI; cookieless; goal/event support | $9/mo for the smallest plan |
| **Fathom** | similar | similar pricing |

What we get either way: page views, country geo, referrer (so I'll know which Reddit comment or HN thread actually drove traffic), CTA click count if I instrument the "Add to Chrome" anchor.

What we don't get: email, identity, install confirmation.

**Concrete move:** Cloudflare Web Analytics. Zero cost, zero privacy regression, ten lines of HTML. Should have been there from day one.

### Tier 1 — Funnel the install through email capture
**Higher friction, but it's the only thing on this list that captures both intent and identity at the actual conversion moment.**

Two variants:

**1a — email-then-link (high friction, max signal)**
- Replace `<a class="button" href="…chromewebstore…">Add to Chrome</a>` with a small inline form: `[email] → [Send me the link]`
- On submit: POST to the existing Google Apps Script, then redirect to the Web Store URL.
- Same script the contact-me form uses. No new infra.

Risk: ~20-50% of would-be installers will bounce when they see the gate. Web Store-driven installs (people who found the listing by search, not by landing page) bypass this entirely — they just install. So the gate only catches landing-page visitors who would have clicked through.

**1b — email-optional (low friction, partial signal)**
- Keep the direct "Add to Chrome" link as the primary CTA.
- Add a smaller sibling: `[email] [Get install link + a heads-up when there's an update]`
- Position both side-by-side or as the small text under the big button.

This gets you the email of people who *want* you to email them — a higher-quality lead, smaller volume.

**Concrete recommendation:** 1b. The store CTA is already discoverable via Tier 0 analytics, so the install count isn't lost. The optional email captures the people who would actually open a DM later. Use the existing Google Apps Script as the sink. Zero new infra.

### Tier 2 — Voluntary CLI commands (`sayhi`, `report`, `recommend`)
**This is where your three brainstorm ideas land. Each is a real, opt-in CLI command. The user types it; we get exactly what they typed and nothing more.**

All three would POST to a single autark-api endpoint, say `POST /v1/chrome-relay/signal`, or reuse the Google Apps Script with a `kind` field. autark-api is the lighter lift since CORS + Worker auth already exist.

**`chrome-relay sayhi`**
```sh
$ chrome-relay sayhi
What email should we associate with this install? (skip to stay anonymous)
> ada@lovelace.com
Anything you want to say? (optional)
> chrome-relay is what I've been looking for; can it do X?
Sending… done. Thanks — Kushal will get this.
```
- Sends `{ kind: "sayhi", email, message, version: chrome-relay@x.y.z, platform: darwin/linux/win32 }`.
- The email field is what you'd otherwise never have. The version + platform give you the install-breakdown you can't get from the Web Store.

**`chrome-relay report`**
```sh
$ chrome-relay report
> The screenshot tool returns blank when the tab is in a background window.
Attach output of `chrome-relay doctor`? [Y/n] y
Sending… filed as bug.
```
- Sends `{ kind: "report", message, doctorOutput, version, platform }`.
- Skill update: the chrome-relay agent skill teaches *Claude* to suggest `chrome-relay report` when an action fails. That converts every failed agent action into either a fix or a real bug report — no other path produces that telemetry.

**`chrome-relay recommend`**
- This is the cross-sell. Two flavors:
  - **outbound**: `chrome-relay recommend` shows the user a one-screen pitch for autark + plumcake with the install one-liners. No data sent. Just printed text.
  - **inbound**: `chrome-relay recommend --me` asks for email and registers them on the autark/plumcake mailing list (lands in the same Google Sheet with `kind: "recommend"`).

The outbound version is the cleaner one — it's just a printed page, like `chrome-relay help`. The inbound flavor is functionally a duplicate of `sayhi` and probably doesn't earn its own command.

**Pattern to keep:** every Tier 2 command MUST print exactly what it will send before sending, and require a Y to confirm. Otherwise we're back to silent telemetry which breaks the privacy promise.

### Tier 3 — Extension popup "tell us why" link
**The lowest-effort piece — half a day. Catches the uninstall-cohort signal Tier 2 misses.**

Edit `apps/extension/entrypoints/popup/main.ts` to add a small footer line:
- `Something broken? Open a report →` (opens a GitHub Issues template URL in a new tab)
- `Loving it? Drop me a hi →` (opens a Tally/Google Form pre-filled with `?source=popup`)

Both are anchor tags. The popup never POSTs anything. The user lands on a hosted form that we already control (Google Apps Script behind the scenes).

The Web Store has the same kind of "support URL" field on the listing page — make sure that points at the same Google Form so uninstallers who never opened the popup also see a path.

---

## 4. Where the data lands — endpoint shape

We need one place for these signals. Two real options:

### Option A — Reuse the existing Google Apps Script
- Already wired to a Google Sheet.
- Already CORS-friendly (the contact form POSTs from a browser).
- Costs zero.
- Schema gets a `kind` column: `contact | sayhi | report | recommend | popup-feedback`.

### Option B — New autark-api endpoint `/v1/chrome-relay/signal`
- Same Cloudflare Worker as the autark dashboard hits.
- Same InstantDB the rest of autark lives in — could query signals alongside hypotheses.
- Costs nothing material (worker requests are basically free).
- Slightly nicer for `chrome-relay report` since we can stamp `created_at` + `id` and return a tracking link.

**Recommend:** A (Apps Script) for the first round — ship in a day, no schema migration. Move to B once we have enough volume that the Google Sheet stops being legible.

---

## 5. What NOT to do — the privacy floor

The promise in `docs/privacy-policy.md` is: *no telemetry by default*. Everything above respects that because:

- Tier 0 is **landing-page** analytics — happens at the marketing-site layer, not in the extension or CLI.
- Tier 1's email capture is **explicitly entered** by the user on a form.
- Tier 2's CLI commands are **user-invoked** and print-before-send.
- Tier 3 is a **link** the user clicks; the popup itself never phones home.

Things that would break the contract and should NOT be added without a privacy-policy revision:
- a silent install ping from the native host
- automatic crash reports from the extension service worker
- a background "phone home" timer
- ANY collection that happens without the user typing a command or clicking a button

If we ever do want passive crash signal — and at some scale we probably will — that's a privacy-policy change *first*, a clear in-popup toggle to opt in, and clear copy that the user explicitly agreed. Not a quiet `fetch()` in a service worker.

---

## 6. Recommended sequence (cheapest first, biggest signal per hour)

1. **Cloudflare Web Analytics on the landing page.** One commit, ships today. Tells me whether outreach is landing.
2. **Tier 1b: optional email field next to the install CTA.** Same commit, same Google Apps Script. The first real source of identity.
3. **Tier 3: "tell us why" link in the extension popup → Google Form.** Half a day. Catches the uninstall cohort and the silent users who'd never type a CLI command.
4. **Tier 2: `chrome-relay sayhi` and `chrome-relay report` CLI commands.** One day. Opt-in, print-before-send, Apps Script sink. The agent skill gets updated to suggest `report` whenever a tool call fails.
5. *(later)* Tier 2 `recommend` as printed-only cross-sell. Trivial.
6. *(much later)* Migrate the sink from Apps Script to `autark-api /v1/chrome-relay/signal` once volume warrants it.

Total to ship 1-4: maybe two days of work, no infra changes beyond a CF Analytics script tag and a few CLI commands. After that we *will* have:
- a real conversion funnel for the landing page,
- emails for the people who want to be reached,
- a feedback channel for both happy and unhappy users,
- voluntary version/platform breakdown for installs.

That's the whole visibility story without touching the privacy promise.
