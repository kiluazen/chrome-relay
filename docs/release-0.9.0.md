# Chrome Relay 0.9.0 release

Prepared on 2026-10-04. Public npm `latest` and the Chrome Web Store listing were both verified as 0.8.2. Merging code does not distribute a new CLI, extension, or installed skill.

## Execution authorization — 2026-10-05

The user retained Chrome Web Store submission and authorized the remaining merges, CLI publication and site/skill updates. The canonical guide and site may publish ahead of the extension with explicit version requirements and the site's pending-extension notice. The verified upload zip is also copied to `/Users/kushalsm/Downloads/chrome-relay-extension-0.9.0-chrome.zip`. New features remain gated until the connected extension is 0.9.0.

## Merge order

The current stack is linear: #5 (`multi-profile-upload`) → #7 (`perf/fast-background-clicks`) → #8 (`perf/agent-loop`) → #9 (`feat/agent-cursor`). Release preparation (`release/0.9.0`) is based on #9 and includes the complete stack; merge it after #9. The canonical guide is prepared in [kstack PR #2](https://github.com/kiluazen/kstack/pull/2), held for publication after both components are live.

Use merge commits to preserve the stack ancestry. Merge #5 into main, retarget #7 to main and merge it, then repeat for #8 and #9. Recheck each live head SHA before merging. A squash of the lower PR requires rebasing the remaining branches to avoid replaying the same changes. Do not delete lower branches while higher PRs still target them.

All four PRs were drafts with no GitHub status checks. Local validation and the combined review are recorded separately; a CLEAN merge state only means GitHub sees no textual conflict.

## What ships where

| Component | Release | Distribution | User action |
|---|---|---|---|
| CLI and native host | 0.9.0 | npm `chrome-relay` | `chrome-relay update` refreshes package and host manifests |
| Browser extension | 0.9.0 | Existing Web Store item `cpdiapbifblhlcpnmlmfpgfjlacebokb` | Chrome updates separately in each installed browser/profile |
| Canonical agent skill | Matching 0.9.0 guide | `kiluazen/kstack`, `skills/chrome-relay` | Refresh previously installed skills; they are local copies |
| CLI core skill | Matching 0.9.0 guide | Inlined into npm binary at build | `chrome-relay skills get core` returns the installed binary's guide |
| Legacy skill mirror | Matching canonical guide | This repository, `skills/chrome-relay` | Supports older extension popup install URLs |
| Site and docs | Matching guide and commands | `landing/public` on the existing host | Deploy generated static output separately |

Both the extension and CLI change. No protocol-version bump or new browser permission is needed: the protocol remains v2, the published extension ID remains stable, and the manifest permissions match 0.8.2.

## Version skew

| Connected pair | Behavior |
|---|---|
| CLI/native host 0.9.0 + extension 0.9.0 | Full navigation/readiness, settled `--snapshot`, cursor and background recording |
| CLI 0.9.0 + extension 0.8.2 | Ordinary commands continue. New readiness/composite/settle/recording-start semantics fail before acting with `unsupported_tool`, phase `extension_compatibility`. `navigate --wait none` retains acknowledgment-only behavior; follow it with a wait for the required element/text |
| CLI/native host 0.8.2 + extension 0.9.0 | Older command surface remains; no CLI `--snapshot` flag. Extension rejects explicit foreground activation. Host reports CLI-outdated notice |
| Pre-v2 extension mixed with a registered profile | Unscoped routing refuses to guess; update the legacy extension or choose the registered profile explicitly |
| Old fixed-port CLI + new native host | Snapshot refs are unqualified on the legacy HTTP surface; authenticated registry routes retain qualified refs |

A navigation result `ready:false` means the deadline expired. Wait for the required state and take a fresh snapshot before acting. DOMContentLoaded does not guarantee app hydration. A sampled recording can miss states between frames.

## Distribution sequence

1. Merge reviewed code and release preparation, retaining the tested source revision. Build the npm tarball, Store zip and generated docs from that revision; keep checksums with the release record.
2. Upload the 0.9.0 zip to the existing Store item and request review with deferred publishing. Update listing text: remove “switch tabs,” describe background operation and sampled recording, and use the honest CDP evaluation description in `docs/chrome-web-store.md`. This release adds no permissions.
3. Publish the verified CLI package to npm. Then verify `npm view chrome-relay version` and install the published package in an isolated test directory. Do not call a registry upload a verified install.
4. When the Store version is approved, publish it. Verify the public listing says 0.9.0; approval/submission alone does not prove users have received it.
5. Merge the canonical kstack guide and deploy `landing/public` through the existing hosting project. Refresh installed agent skills explicitly; rebuilding the CLI does not rewrite users' skill directories.
6. Check a real connected profile reports native-host and extension 0.9.0, then run a harmless navigate → snapshot → click → snapshot flow and a background recording. Until then, only isolated headless/native-host proof is available.
7. Send the user update only after the public CLI and Store versions are live. Show the exact message before sending; no outreach is part of release preparation.

Google documents [deferred publishing and extension updates](https://developer.chrome.com/docs/webstore/update) and [automatic extension update checks](https://developer.chrome.com/docs/extensions/how-to/distribute). Automatic delivery is asynchronous; users do not receive both components atomically.

## Local build and validation

Run from the release checkout:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build:cli
pnpm --filter chrome-relay-extension exec wxt build --mode development
pnpm test:e2e
node apps/extension/scripts/two-profile-bench.mjs
node apps/extension/scripts/agent-loop-bench.mjs --composite --iterations 4 --real --json /tmp/chrome-relay-0.9.0-loop.json
pnpm --dir landing install --ignore-workspace --no-frozen-lockfile
pnpm --dir landing run build:docs
pnpm store:zip
```

Headless Chromium and temporary browser profiles only. The two native-host benchmarks also set `CHROME_RELAY_NO_LEGACY_PORT=1` in their isolated CLI processes, preventing discovery from touching the developer's live fixed-port host. Benchmark missing action targets, stale post-click snapshots and failed loops are failures, not successful timing samples.

Package the CLI with `npm pack` in `packages/cli`; it ships only `dist`. Inspect the extracted package version, CLI/host entrypoints, dependency list, release notes, and inlined guide. The Store zip must have version 0.9.0, no development key, and no development-only runTool hook. Production packaging runs after development-mode browser tests.


## Recorded validation

The complete integration source passed 577 unit tests (122 protocol, 241 extension, 214 CLI), typecheck and lint. All 56 end-to-end browser tests passed after the development/production build split. Read-only macOS focus sampling recorded 94 unchanged foreground samples and zero Chromium foreground samples. Browser contexts were headless and disposable.

The two-profile CLI → native host → extension benchmark passed routing, qualified-ref, conflict and actual file-delivery checks. The composite benchmark passed all 20 loops (four per fixture/site), including real Hacker News pagination and fresh post-click snapshots. Current medians:

| Workload | Median |
|---|---:|
| 200-row full loop | 321 ms |
| 1,500-row full loop | 1146 ms |
| Hacker News full loop | 807 ms |
| Wikipedia navigate + snapshot | 1004 ms |
| GitHub navigate + snapshot | 615 ms |

These are current release measurements, not a new before/after baseline. An actual child native host also survived injected descriptor-write failure and reported the diagnostic. The packed CLI installed in an isolated directory and returned 0.9.0, the matching release notes and core guide; the native-host entrypoint was present.

The production zip has 0.9.0, unchanged permissions, no development key and no service-worker test hook. Development builds retain the hook and stable test key under `build/chrome-mv3-dev`. Store upload, review, publication, installed-user delivery and site deployment remain separate gates and have not occurred.

Prepared artifacts and logs are outside the checkout at `/Users/kushalsm/solo/chrome-relay-release-artifacts/0.9.0`. SHA-256:

```text
c94a1497b192bd35126fa975edd401d7111c42ae2d49c7ec685c74c1e64c8dd3  chrome-relay-extension-0.9.0-chrome.zip
a422543f5df7f3e0096370804ec3a1d29c4170ede2536b7f226d121425b1dbf9  chrome-relay-0.9.0.tgz
```

Combined review identified 14 issues in the original stack. The integration addresses all 14; bounded rereview also cleared legacy batch refs, benchmark loading detection and the build split. The local review receipt and remediation record are retained with the release evidence. The original stack receipt applies to its original head, not to this corrected integration.

## Recovery

Retain the 0.8.2 package and exact new artifacts. Do not reuse a published version number. A CLI regression gets a new patch release; users can temporarily install `chrome-relay@0.8.2` and rerun `install`. For an extension regression, use the Store's documented rollback flow or publish a corrected, higher version. Keep compatibility gates until the connected versions are verified. Never bring a tab to the foreground as a recovery step.
