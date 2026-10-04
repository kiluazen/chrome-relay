# Agent cursor

Codex's computer use draws its own cursor and leaves yours alone: it glides to targets, wiggles while the model thinks, and lets several agents work in the background while you keep using the machine. Chrome Relay already acts without your mouse (CDP input to background tabs). The cursor makes that work visible in the tab, without giving up speed or background operation.

## What it does

- Each click, hover, fill and type (ref, selector or coordinates) moves an arrow in that tab to the target point along a short curved path. Duration scales with distance, from 160 to 460 ms.
- A click pulses a cyan ring. Typing shows a small "typing" tag.
- `keys` and selector-mode fill/type have no point of their own. They wake the arrow where it is.
- Between commands (the agent is thinking) the arrow wiggles. After 15 s idle it fades.
- `screenshot` hides it for the capture. Screencast recordings keep it, so a recording shows what the agent did.
- `chrome-relay cursor off` stops drawing it for every tab of the profile. The setting lives in `chrome.storage.local`.

## Why it can't get in the way

- **Speed.** Moving the arrow is one `Runtime.evaluate` (~1 ms) that starts a time-based Web Animation and returns. The input is dispatched right after; nothing waits for the glide.
- **Page scripts.** The code runs in a named CDP isolated world, which Chrome reuses per document, so its state persists between calls. The page can't call or tamper with it, and `window.__crCursor` is undefined on the page.
- **Snapshots and hit tests.** The host element is `aria-hidden` (no AX node), zero-sized, `pointer-events: none`, and drawn in a closed shadow root. Ref hit tests (`elementFromPoint`) and CDP input go straight through it.
- **Page observers.** The only light-DOM change is appending the host once per document. Every later move happens inside the closed shadow tree, which page MutationObservers don't see. Settle arms after the arrow moves, so its own counter doesn't count the arrow either.
- **Background tabs.** Animations are time-based, so a tab you switch to mid-task shows the arrow where it should be. Nothing activates the tab.

## Limits

- It's drawn at `z-index: 2147483647`, not in the top layer, so a modal `<dialog>` or popover covers it.
- A page can still notice an unknown `chrome-relay-cursor` element under `<html>`. Turn the cursor off on pages where that matters.
- No wallpaper-derived color. It uses the brand palette: dark blue-green fill, cream outline, cyan glow.
