# Sharing the browser with the person

Chrome Relay drives the Chrome someone is using. Both have to be able to work
in it at the same time. Before this, the extension attached the debugger to
every tab it touched and kept it attached until the tab closed. Those tabs
stayed under focus emulation, forced-active lifecycle and the
`document.hidden`/`hasFocus` shim while the person used them. A click or key
cut short (navigation mid-press, a thrown error) could leave a button or key
"held" in the tab. And nothing stopped the agent from typing into the field
the person was typing in.

## Leases (`apps/extension/src/browser/cdp.ts`)

- A command attaches; the tab is released after `IDLE_DETACH_MS` (30 s)
  without one. Releasing lets go of held input, reverts the in-page shim
  (`UNPATCH_VISIBILITY_SCRIPT`), takes down the agent cursor, then detaches.
  Detaching drops focus emulation, the lifecycle override and the
  new-document script, and hides Chrome's debugging bar.
- Pins (`lease-hooks.ts`): console capture, network capture and viewport
  emulation live in the session, so those tabs stay attached. When idle they
  go **quiet** instead: input released, shim reverted, focus emulation off,
  new-document script removed. The next command re-applies everything.
- `onBeforeDetach` / `onAfterDetach` let modules clean up (cursor world,
  settle trackers, console/network subscriptions). After-detach also runs
  when Chrome ends the session itself (tab closed, Cancel on the bar).
- `release` ignores pins. `releaseAll` also detaches sessions that survived a
  service-worker restart (found via `chrome.debugger.getTargets`; detach only
  succeeds on sessions this extension owns).

## Input always finishes (`cdp.ts`, `keyboard.ts`, `handlers/input.ts`, `a11y.ts`, `handlers/upload.ts`)

- Every press/down/drag sends its release/up/cancel in a `finally`.
- `send()` tracks held mouse buttons, keys and drags. A press is marked held
  before sending (it may land even if the call throws); a release clears it
  only once sent. Releasing or quieting a tab lets go of whatever is left.

## The person comes first (`human.ts`, `entrypoints/human-input.content.ts`)

- A content script reports trusted `keydown` / `pointerdown` / `wheel`
  events, throttled to one message per 250 ms. Only the fact that input
  happened is sent, never page content.
- Agent input that starts something (mouse/key/drag/touch/insertText,
  `DOM.focus`, file input, `fill`) waits while the person has been active in
  that tab within the last 1.5 s. After 8 s it fails with retryable
  `user_active`. Releases never wait, so a sequence already started still
  ends.
- CDP input is trusted too, so reports during agent input or within 400 ms
  after it are treated as the agent's own echo.
- Other tabs are unaffected: the agent keeps working in background tabs
  while the person types elsewhere.

## Agent tabs (`agent-tabs.ts`)

`navigate --new` without `--group`/`--workspace` puts the tab in a grey
"Agent" tab group in its window, so the person sees which tabs are being
driven. Best effort; never fails the navigate.

## Seeing and ending it

- `chrome-relay status` (`chrome_status`): held tabs, active/quiet, pins,
  in-flight commands, last command, idle timer, held input, and how long
  since the person last used each tab.
- `chrome-relay release [--tab N]` (`chrome_release`): every tab by default.
- Popup: "Agent tabs" card with a Release button.

## Trade-offs

- Console/network events are captured only while the session is open. A
  pinned tab keeps it open, so capture continues while quiet.
- Re-attaching after an idle release costs one attach plus the shim calls
  (tens of ms) and flashes Chrome's debugging bar again.
- Pages that only render while they think they're focused (the Cloudflare
  dashboard is the known case) get the shim back on the next command. They
  may pause while a tab is released.
- The content script only exists in pages loaded after install/update.
