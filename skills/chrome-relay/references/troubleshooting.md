# Troubleshooting

Failure modes and how to recognize them.

## "Click registered, but nothing happened"

Symptom: `chrome-relay click` returns `{clicked: true}`, no error. Dropdown / menu / popover does not open. Page state unchanged.

Most common cause: chrome-relay **<0.5.20**. Pre-0.5.20 versions of CDP `Input.dispatchMouseEvent` fire only mouse events, not pointer events. Modern UI libs (Radix, React-Aria, Headless UI) listen on `pointerdown` and silently ignore mouse-only clicks.

Diagnostic — attach listeners and look for `pointerdown` (see [patterns.md "Trace which events actually fire"](patterns.md)). If you see `mousedown` but no `pointerdown`:

```sh
chrome-relay --version
pnpm add -g chrome-relay@latest
chrome-relay self-reload     # reload the extension service worker too
```

Other causes:
- Coords landed on a wrapper element (see "Click landed on wrong element" below)
- Element exists in DOM but is occluded by something with higher z-index — `document.elementFromPoint(x, y)` will tell you

## "Click landed on the wrong element" (stale coords)

Symptom: you read `getBoundingClientRect`, click, and `elementFromPoint` of those coords is now a parent FORM, DIV wrapper, or even the page background.

Cause: the page reflowed between read and click. Common in:
- Autocomplete dropdowns (popup re-renders as you type)
- Pages with progressive image loading (layout shift)
- Anything that animates in/out

Fix:
- For combobox flows, use keyboard nav instead (see [patterns.md "Combobox / autocomplete"](patterns.md))
- For everything else, read coords as late as possible:
  ```js
  el.scrollIntoView({block: 'center'});
  await new Promise(r => setTimeout(r, 150));  // let layout settle
  const r = el.getBoundingClientRect();        // read
  // immediately click — no awaits between
  ```
- Use `chrome-relay click <selector>` (selector mode) when you have one — it re-resolves coords in-page right before dispatching.

## "type added on top of existing value"

Symptom: input had `"Untitled"`, you typed `"My Doc"`, value is now `"UntitledMy Doc"`.

Cause: `chrome-relay type` uses CDP `Input.insertText` which inserts at the caret. It does not replace the value.

Fix: clear first. See [patterns.md "Clear, then type"](patterns.md). For most React-controlled inputs, the JS `value` setter + `input` event is the only thing that works.

## "Page won't render in background"

Symptom: `chrome-relay navigate --new` opens a tab in the background; screenshot is blank or stuck on a loading skeleton even minutes later.

Cause until 0.5.18: chrome-relay didn't override `document.visibilityState`. Many SPAs (Cloudflare dashboard, Linear, Notion) gate their bootstrap JS on `document.visibilityState === 'visible'` and stall on backgrounded tabs.

Fix: upgrade to 0.5.18+. The fix is in the attach flow; you don't have to do anything else. If a specific page still won't render, check:

```sh
chrome-relay js --tab $TAB "return {
  visState: document.visibilityState,
  hidden: document.hidden,
  hasFocus: document.hasFocus()
}"
```

All three should reflect "visible" / "focused" — if not, the shim didn't apply (file a bug).

## "Version mismatch" warning

Stdout prefix:
```
[chrome-relay] cli-outdated: 0.5.16 < extension 0.5.20; run `chrome-relay update`
```

The extension and CLI are versioned independently. The extension lives in Chrome; the CLI is `chrome-relay` on `$PATH`. Either may be older. Run `chrome-relay update` (updates the CLI) and reload the extension from chrome://extensions if needed.

## "Native host not found"

`chrome-relay doctor` fails with `native messaging host not registered` or similar.

Fix:
```sh
chrome-relay install      # re-registers the native messaging manifest
chrome-relay doctor
```

If still failing, the extension and CLI may be talking to different host names. The install command writes `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chrome_relay.host.json` on macOS — check it exists and points to a real binary.

## "Tab ID not found"

You stored a `tabId` and it's now invalid (user closed the tab, restarted Chrome, etc.). Always re-list tabs at the start of a session:

```sh
chrome-relay tabs > /tmp/tabs.json
jq '.windows[].tabs[] | select(.url | test("npmjs.com"))' /tmp/tabs.json
```

## "Click works in tests but not in the real Chrome session"

Tests run with `pointerType: "mouse"` (post-0.5.20). The agent's local CLI may still be older. Always check:

```sh
chrome-relay --version
```

Tests in `apps/extension/test/` exercise the handler code directly via vitest; they don't exercise the CLI version on the agent's machine. A passing test does not mean the agent's local CLI is current.
