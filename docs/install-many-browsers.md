# Installing chrome-relay across many browsers and profiles

One `chrome-relay` CLI reaches **every supported browser and browser profile where the
extension is installed**. The primary tested targets are Google Chrome (including
multiple Chrome profiles), Dia, and Brave. Each install is its own
addressable instance; the CLI routes every command to exactly one of them
(see [`one-cli-many-browsers.md`](./one-cli-many-browsers.md) for how).

## Steps

1. **Install the extension everywhere you want the CLI to reach.**
   [Chrome Web Store →](https://chromewebstore.google.com/detail/chrome-relay/cpdiapbifblhlcpnmlmfpgfjlacebokb)
   — once per browser *and* once per Chrome profile (each profile keeps its
   own extensions). A browser/profile without the extension is invisible to
   the CLI; there is no other setup per profile.

2. **Install the CLI once** (it serves all of them):
   ```sh
   pnpm add -g chrome-relay     # or npm i -g chrome-relay
   chrome-relay install         # writes native-messaging manifests for every detected browser
   ```
   `install` also knows manifest paths for detected Chrome Canary, Chromium,
   Edge, Vivaldi, Arc, and Opera installations. Those are compatibility targets,
   not a claim of the same end-to-end test coverage as Chrome, Dia, and Brave.
   Already-running extensions connect within seconds;
   no browser restart needed.

3. **See what's connected, name things:**
   ```sh
   chrome-relay profile list          # label, browser, id prefix, reachability
   chrome-relay profile label work    # one connected: label it directly
   chrome-relay --profile 5f85 profile label personal   # several connected: pick by id prefix
   ```
   Labels are yours to choose ("work", "personal", "dia", …), unique, and
   freed with `profile unlabel <name>` if a profile goes away.

4. **Use it:**
   ```sh
   chrome-relay --profile work tabs
   chrome-relay --profile dia navigate "https://…" --new
   chrome-relay click @3f2a:e12       # refs route by themselves — no flag needed
   ```

## Behavior to expect

- **One instance connected** → zero flags, everything routes implicitly.
  Nothing about multi-profile exists for you until a second instance shows up.
- **Several connected** → an unscoped command fails `profile_ambiguous`
  and the error itself is the menu: one line per candidate with its label,
  browser, id prefix, and the exact `--profile …` to rerun with.
- Snapshot refs are profile-qualified (`@3f2a:e12`) and carry their routing
  with them — after one snapshot you rarely type `--profile` again.
- `chrome-relay doctor` shows every registered instance with its browser,
  label, reachability, and whether the file-URL toggle (needed by `upload`)
  is on.

## Troubleshooting

- **A browser's extension never appears in `profile list`** → its manifest
  is probably missing: re-run `chrome-relay install` (and check the browser
  is in the printed list). Dia support needs CLI ≥ 0.8.1.
- **An instance shows UNREACHABLE** → its host isn't answering (usually
  mid-restart). Retry; if it persists, restart that browser profile.
- **Old extension (< 0.8.0) in some profile** → it works exactly as before
  through the legacy fixed port, but can't be profile-addressed until it
  updates.
