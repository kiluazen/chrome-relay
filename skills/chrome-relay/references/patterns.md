# Patterns

Recipes that took an hour to discover, written down so they don't have to be re-discovered.

## Combobox / autocomplete option selection

Filter inputs with a dropdown of matching options (npm package picker, Linear assignee picker, GitHub repo search). The popup re-renders fast — coord-clicking a specific option lands on stale coordinates and hits the form background.

```sh
# 1. Click the filter input
chrome-relay click "<filter-input-selector>" --tab $TAB

# 2. Type the search query
chrome-relay type "chrome-relay" --tab $TAB

# 3. Keyboard-navigate. ArrowDown highlights the first match; Enter commits it.
chrome-relay keys "ArrowDown" --tab $TAB
chrome-relay keys "Enter" --tab $TAB
```

Why: comboboxes are built around keyboard nav (it's their accessibility contract). The first option auto-highlights or one ArrowDown highlights it; Enter is the canonical "select" action. Coord-clicking fights the popup's lifecycle.

## Click by visible text

There's no `click-text` verb on purpose — `js` + `click --x --y` composes the same thing more explicitly.

```sh
COORDS=$(chrome-relay call chrome_evaluate '{"code":"
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node;
  while (node = walker.nextNode()) {
    if (node.offsetParent && (node.textContent||\"\").trim() === \"Generate token\") {
      node.scrollIntoView({block: \"center\"});
      const r = node.getBoundingClientRect();
      return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)};
    }
  }
  return null;
"}' --tab $TAB | jq '.result')

X=$(echo "$COORDS" | jq -r '.x')
Y=$(echo "$COORDS" | jq -r '.y')
chrome-relay click --x "$X" --y "$Y" --tab $TAB
```

Variants: match by `.includes(text)` for partial, by `.matches(selector)` for tag constraint, by `aria-label` for icon buttons.

## Clear, then type (overwrite a pre-filled input)

`chrome-relay type` inserts at the caret. If the input already has a value (autosaved draft, today's date, "Untitled"), the new text appends.

Option A — clear via JS (most reliable for React-controlled inputs):
```sh
chrome-relay js --tab $TAB "
  const el = document.getElementById('create-gat_tokenName');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '');
  el.dispatchEvent(new Event('input', {bubbles: true}));
  return 'cleared';
"
chrome-relay click "<input-selector>" --tab $TAB    # refocus
chrome-relay type "the new value" --tab $TAB
```

Option B — select-all + delete (works for plain inputs, may not commit cleanly in controlled components):
```sh
chrome-relay click "<input-selector>" --tab $TAB
chrome-relay keys "Cmd+a" --tab $TAB
chrome-relay keys "Backspace" --tab $TAB
chrome-relay type "the new value" --tab $TAB
```

## Extract a value to a file without echoing it

When pulling secrets (API keys, one-time tokens) out of a page, never let them flow through shell `$(...)` and then `echo`. Route the body of the JS expression directly to a file:

```sh
chrome-relay call chrome_evaluate '{"code":"return (document.body.innerText.match(/npm_[A-Za-z0-9]{30,}/) || [\"\"])[0]"}' --tab $TAB \
  | jq -r '.result' \
  > ~/.npm-token-tmp

# Use the file, never print it:
sed -i.bak "s|//registry.npmjs.org/:_authToken=.*|//registry.npmjs.org/:_authToken=$(cat ~/.npm-token-tmp)|" ~/.npmrc
rm ~/.npm-token-tmp ~/.npmrc.bak
```

`echo "$TOKEN"`, `echo "captured length: ${#TOKEN}"`, even printf with the var — all of these get the secret into terminal scrollback, agent transcripts, and possibly logs. The `jq -r '.result' > file` pattern is the only path that doesn't.

## Trace which events actually fire

When a click "succeeds" but the page doesn't react, the only useful question is: *which events did the page actually see?*

```sh
chrome-relay js --tab $TAB "
  ['pointerdown','pointerup','mousedown','mouseup','click'].forEach(t =>
    document.addEventListener(t, e => console.log('[evt]', t, e.target.tagName, e.target.className?.toString?.()?.slice(0,40)), {capture: true})
  );
  return 'listening';
"

# Now do the click that's failing:
chrome-relay click --x 506 --y 723 --tab $TAB

# Read what fired:
chrome-relay console --tab $TAB | grep '\[evt\]'
```

If you see `mousedown` but no `pointerdown` → you're on chrome-relay <0.5.20 (missing `pointerType: "mouse"` in CDP dispatch). Upgrade.

If you see no events at all → coord is wrong; check `document.elementFromPoint(x, y)`.

If you see events on a wrapper instead of your target → coord is stale (the page reflowed between read and click). Re-read coords immediately before the click.

## Use workspaces when running multiple agents

If multiple agents are driving the same Chrome, they'll fight over `--tab` IDs. Pin each agent to a named window:

```sh
chrome-relay workspace create research
chrome-relay --workspace research navigate "https://google.com/search?q=..." --new
chrome-relay --workspace research tabs    # only sees its own window
```

The `--workspace` flag at the top level scopes every subsequent command.
