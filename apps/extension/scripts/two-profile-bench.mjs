// Two-profile full-stack bench — the multi-profile smoke test, hermetic.
//
// What it proves that no unit/e2e suite can: the ENTIRE production path
// with TWO Chrome profiles at once — extension → chrome.runtime.connectNative
// → real native host process → descriptor registry → real CLI binary routing
// between them by label and by qualified-ref prefix.
//
// How it stays isolated from the developer's real Chrome:
//   - Playwright Chromium with throwaway --user-data-dirs (one per profile);
//     Chromium reads NativeMessagingHosts manifests from INSIDE the user
//     data dir, so the manifests only exist for these two profiles.
//   - The host wrapper exports CHROME_RELAY_HOME=<temp>, so descriptors and
//     labels never touch ~/.chrome-relay.
//   - CHROME_RELAY_NO_LEGACY_PORT=1 keeps bench hosts off port 12122, where
//     a production host may live.
//
// Run: node apps/extension/scripts/two-profile-bench.mjs
// Prereqs: pnpm build (extension build/chrome-mv3 + cli dist).

import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const EXT_PATH = path.join(ROOT, "apps", "extension", "build", "chrome-mv3");
const HOST_JS = path.join(ROOT, "packages", "cli", "dist", "native-host.js");
const CLI_JS = path.join(ROOT, "packages", "cli", "dist", "cli.js");
const FIXTURE = path.join(ROOT, "apps", "extension", "test", "e2e", "fixtures", "upload.html");
// Pinned by the manifest key in wxt.config; see LOCAL_UNPACKED_EXTENSION_ID
// in packages/protocol/src/index.ts.
const EXTENSION_ID = "cleiodnaklknhhfopegimjelfibjmbkc";
const HOST_NAME = "dev.chrome_relay.native_host";

const HOME = mkdtempSync(path.join(tmpdir(), "chrome-relay-bench-home-"));
const cleanups = [];
let failures = 0;

function check(label, ok, detail = "") {
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function cli(args, { expectFail = false } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_JS, ...args],
      { env: { ...process.env, CHROME_RELAY_HOME: HOME }, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (!expectFail && error) {
          check(`cli ${args.join(" ")}`, false, `unexpected failure: ${stderr || error.message}`);
        }
        resolve({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr), failed: !!error });
      }
    );
  });
}

function serveFixture() {
  const html = readFileSync(FIXTURE);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cleanups.push(() => server.close());
      resolve(`http://127.0.0.1:${server.address().port}/upload.html`);
    });
  });
}

async function launchProfile(tag) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), `chrome-relay-bench-${tag}-`));
  const nmDir = path.join(userDataDir, "NativeMessagingHosts");
  mkdirSync(nmDir, { recursive: true });

  const wrapper = path.join(userDataDir, "run-dev-host.sh");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexport CHROME_RELAY_HOME="${HOME}"\nexport CHROME_RELAY_NO_LEGACY_PORT=1\nexec "${process.execPath}" "${HOST_JS}"\n`
  );
  chmodSync(wrapper, 0o755);

  writeFileSync(
    path.join(nmDir, `${HOST_NAME}.json`),
    JSON.stringify({
      name: HOST_NAME,
      description: "chrome-relay dev bench host",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    }, null, 2)
  );

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });
  cleanups.push(async () => {
    await context.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  });
  return context;
}

function descriptors() {
  try {
    return readdirSync(path.join(HOME, "instances"))
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(readFileSync(path.join(HOME, "instances", n), "utf8")));
  } catch {
    return [];
  }
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  console.log(`bench home: ${HOME}\n`);

  console.log("Phase 1 — two profiles come up and register");
  await launchProfile("alpha");
  await launchProfile("beta");
  const descs = await waitFor(
    () => (descriptors().length === 2 ? descriptors() : null),
    "2 instance descriptors"
  );
  check("two hosts wrote ping-verifiable descriptors", descs.length === 2);
  const prefixes = descs.map((d) => d.instanceId.replace(/-/g, "").slice(0, 4));
  check("distinct instanceIds", new Set(prefixes).size === 2, prefixes.join(", "));

  const list = await cli(["profile", "list"]);
  const connected = JSON.parse(list.stdout).connected ?? [];
  check("profile list shows both, ping-verified", connected.length === 2);

  console.log("\nPhase 2 — routing strictness");
  const ambiguous = await cli(["tabs"], { expectFail: true });
  check(
    "unscoped command hard-fails profile_ambiguous",
    ambiguous.failed && ambiguous.stderr.includes("profile_ambiguous")
  );

  const [pa, pb] = connected.map((c) => c.prefix);
  await cli(["--profile", pa, "profile", "label", "alpha"]);
  await cli(["--profile", pb, "profile", "label", "beta"]);
  const relisted = JSON.parse((await cli(["profile", "list"])).stdout).connected;
  check(
    "labels bound and unique",
    relisted.every((c) => c.label === "alpha" || c.label === "beta")
  );
  const labelClash = await cli(["--profile", pb, "profile", "label", "alpha"], { expectFail: true });
  check("relabeling to a taken name fails label_conflict", labelClash.stderr.includes("label_conflict"));

  const scoped = await cli(["--profile", "alpha", "tabs"]);
  check(
    "--profile <label> routes, stamped on stderr",
    !scoped.failed && scoped.stderr.includes("profile: alpha")
  );

  console.log("\nPhase 3 — qualified refs route across profiles");
  const url = await serveFixture();
  await cli(["--profile", "alpha", "navigate", url, "--new"]);
  const tabsOut = JSON.parse((await cli(["--profile", "alpha", "tabs"])).stdout);
  // Robust tab lookup regardless of output shape: walk for an object that
  // has a numeric id and a url containing the fixture.
  const fixtureTab = (function find(node) {
    if (Array.isArray(node)) {
      for (const v of node) { const hit = find(v); if (hit !== null) return hit; }
      return null;
    }
    if (node && typeof node === "object") {
      const values = Object.values(node);
      const url = values.find((v) => typeof v === "string" && v.includes("upload.html"));
      const id = typeof node.id === "number" ? node.id : typeof node.tabId === "number" ? node.tabId : null;
      if (url && id !== null) return id;
      for (const v of values) { const hit = find(v); if (hit !== null) return hit; }
    }
    return null;
  })(tabsOut);
  check("fixture tab found in profile alpha", fixtureTab !== null, `tab ${fixtureTab}`);

  const snap = await cli(["--profile", "alpha", "snapshot", "--tab", String(fixtureTab), "-i"]);
  const refMatch = /\[ref=([0-9a-f]{4}:e\d+)\]/.exec(snap.stdout);
  check("snapshot mints QUALIFIED refs through the real host", refMatch !== null, refMatch?.[1]);
  const alphaPrefix = relisted.find((c) => c.label === "alpha").prefix;
  check("ref prefix matches profile alpha's instanceId", refMatch?.[1]?.startsWith(alphaPrefix));

  const buttonRef = [...snap.stdout.matchAll(/button "Upload a file" \[ref=([^\]]+)\]/g)][0]?.[1];
  check("trigger button got a ref", !!buttonRef, buttonRef);

  // The headline primitive: a bare `click @ref` with TWO profiles connected
  // and NO --profile — the token itself routes.
  const refClick = await cli(["click", `@${buttonRef}`]);
  check("bare `click @qualified-ref` routes by prefix alone", !refClick.failed);

  const conflict = await cli(["--profile", "beta", "click", `@${buttonRef}`], { expectFail: true });
  check(
    "--profile beta + alpha's ref → target_conflict",
    conflict.failed && conflict.stderr.includes("target_conflict")
  );

  console.log("\nPhase 4 — upload through the real stack");
  const payload = path.join(HOME, "hello.txt");
  writeFileSync(payload, "hello from the bench");
  const uploadSet = await cli([
    "--profile", "alpha", "upload", "set", "--selector", "#direct", "--tab", String(fixtureTab), payload
  ], { expectFail: true }); // may fail file_access_denied depending on toggle default — record truth either way
  if (!uploadSet.failed) {
    check("upload set delivered the file (verified readback)", uploadSet.stdout.includes("hello.txt"));
  } else {
    check(
      "upload set blocked ONLY by the file-URL toggle (expected structured error)",
      uploadSet.stderr.includes("file_access_denied"),
      "toggle off in this profile — gate fired with remediation, as designed"
    );
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
}

try {
  await main();
} catch (e) {
  failures += 1;
  console.error("bench error:", e);
} finally {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
  rmSync(HOME, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
