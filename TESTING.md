# Testing chrome-relay

Two tiers, the way gstack does it.

| Tier | Command | Cost | What it tests |
|------|---------|------|---------------|
| 1 — Static unit | `pnpm test` | free, ~3s | Pure logic. Keyboard key resolution, page-actions DOM helpers, CDP wrapper, CLI argument parsing, protocol shape. |
| 2 — E2E | `pnpm test:e2e` | free (local Chromium), ~60s | Real Chrome with the unpacked extension. Drives `runTool` against fixture HTML pages that reproduce real-world failure modes. |
| All | `pnpm test:all` | free, ~70s | Tier 1 then Tier 2. |

Tier 1 must stay fast. Run on every commit. Tier 2 runs on demand and in CI.

## Layout

```
chrome-relay/
├── packages/
│   ├── protocol/test/protocol.test.ts      # tier 1 — type/values
│   └── cli/test/program.test.ts             # tier 1 — argv → bridge body
└── apps/extension/
    ├── test/
    │   ├── setup-chrome-mock.ts             # vi.fn-based chrome global
    │   ├── keyboard.test.ts                 # tier 1 — pressKey
    │   ├── cdp.test.ts                      # tier 1 — attach/send/eval
    │   ├── page-actions.test.ts             # tier 1 — jsdom DOM helpers
    │   └── e2e/
    │       ├── helpers/
    │       │   ├── extension-context.ts     # Playwright fixture: load extension + drive runTool
    │       │   └── fixture-server.ts        # local HTTP for fixtures
    │       ├── fixtures/                    # one HTML per failure mode
    │       └── specs/                       # one .spec.ts per fixture
    └── playwright.config.ts
```

## Tier 1 — running and adding tests

```sh
pnpm test                            # all packages
pnpm --filter chrome-relay-extension test
pnpm --filter chrome-relay test
pnpm --filter @chrome-relay/protocol test
```

Tests use Vitest. The extension package mocks `globalThis.chrome` via `test/setup-chrome-mock.ts` — every test starts with a fresh stub of `chrome.debugger`, `chrome.tabs`, `chrome.windows`. To assert what was sent over CDP, read `getChromeStub().debugger.sendCommand.mock.calls`.

`page-actions.test.ts` runs in jsdom (set per file via `// @vitest-environment jsdom`).

## Tier 2 — running and adding tests

```sh
# One-time: install Chromium for Playwright
pnpm --filter chrome-relay-extension test:e2e:install

# Run all e2e specs
pnpm test:e2e

# Open the Playwright UI for debugging
pnpm --filter chrome-relay-extension test:e2e:ui
```

The e2e suite boots Chromium with the unpacked extension via Playwright `launchPersistentContext` and reaches into the extension's service worker with `serviceWorker.evaluate(...)` to call `runTool` directly. No need to set up native messaging or a CLI bridge in tests.

### Adding a fixture

A fixture is one HTML page that reproduces one specific behavior. Keep them small (~50 lines). Don't paste a full real-world page in.

1. Create `test/e2e/fixtures/<name>.html`. Expose `window.__diag` returning whatever your assertions need.
2. Create `test/e2e/specs/<name>.spec.ts`:
   ```ts
   import { test, expect } from "../helpers/extension-context";

   test.describe("<feature>", () => {
     test("<scenario>", async ({ runTool, openFixture }) => {
       const { tabId } = await openFixture("<name>.html");
       await runTool("chrome_click_element", { tabId, selector: "#x" });
       const diag = await runTool<{ result: { ok: boolean } }>("chrome_evaluate", {
         tabId, code: "return window.__diag()"
       });
       expect(diag.result.ok).toBe(true);
     });
   });
   ```

The `runTool` fixture-injection lets the spec call any tool by name. Argument shapes match what the bridge sends — see `packages/protocol/src/index.ts` for the contract.

### Existing fixtures and what they test

| Fixture | Failure mode tested |
|---|---|
| `react-controlled-input.html` | `fill` uses native prototype setter to bypass React's value tracker |
| `lexical-editor.html` | `type` produces trusted `beforeinput` events that contenteditable editors require |
| `shadow-dom.html` | `read -i` cannot see shadow children (regression spec); `js` can pierce |
| `native-select.html` | `fill` switches `<select>` value and fires `change` |
| `is-trusted-click.html` | CDP `Input.dispatchMouseEvent` is `isTrusted=true`; in-page `el.click()` is not |
| `dynamic-element.html` | `click` fails fast on missing selector; succeeds after element appears |
| `keyboard-special.html` | `Input.dispatchKeyEvent` produces correct `key`/`code`/`isTrusted` for Enter, Tab, Esc, arrows, chords |
| `js-async.html` | `Runtime.evaluate` with `awaitPromise` + MAIN-world access to framework globals |
| `screenshot-bg.html` | `Page.captureScreenshot` works on backgrounded tabs without focus theft; `--full` extends beyond viewport |

## Why no Tier 3 (LLM eval) yet

The skill is iterating fast. Burning ~$4/run on LLM-as-judge while the SKILL still changes is wasteful. Add Tier 3 once the skill is stable and we have a baseline of "agent picks `type` vs `fill` vs `js` correctly" prompts to grade against.

## Principles (lifted from gstack)

- **Tiered by cost.** Tier 1 must run on every commit. Tier 2 on demand.
- **Extract, don't copy.** Fixtures are one-purpose pages, not 2000-line clones of real apps.
- **Test the surface, not the implementation.** Specs drive `runTool` from outside. The CDP migration we did earlier didn't have to change a single test, because the public tool surface stayed identical.
- **Examples-based.** Each fixture documents one real-world failure. When you find a new failure, add a fixture before fixing the bug.
