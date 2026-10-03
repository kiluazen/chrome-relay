// Agent-loop bench — times the full "open page → ready → snapshot → act"
// loop through the production path (real CLI binary → real native host →
// extension → CDP), in isolated headless Chromium.
//
// It reports per-step medians so an optimization can be attributed to the
// step it changed, plus two overhead probes:
//   - cli:  one `chrome-relay tabs` process (node startup + routing + call)
//   - http: the same call posted straight to the host (relay latency only)
//
// Isolation is the same as two-profile-bench.mjs: throwaway user data dir,
// NativeMessagingHosts manifest inside it, CHROME_RELAY_HOME in a temp dir,
// no legacy port. Never touches the developer's real Chrome or desktop focus.
//
// Run:  node apps/extension/scripts/agent-loop-bench.mjs [--iterations 8] [--real] [--json out.json]
// Prereqs: pnpm build (extension build/chrome-mv3 + cli dist).

import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

function extensionIdFromManifest(manifestPath) {
  const { key } = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!key) throw new Error("extension build has no manifest key; build it in development mode (NODE_ENV=development npx wxt build)");
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const EXT_PATH = path.join(ROOT, "apps", "extension", "build", "chrome-mv3");
const HOST_JS = path.join(ROOT, "packages", "cli", "dist", "native-host.js");
const CLI_JS = path.join(ROOT, "packages", "cli", "dist", "cli.js");
// Derived from the built manifest's key (wxt.config DEV_KEY), so the
// native-host manifest always allows the extension that actually loads.
const EXTENSION_ID = extensionIdFromManifest(path.join(EXT_PATH, "manifest.json"));
const HOST_NAME = "dev.chrome_relay.native_host";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ITERATIONS = Number(opt("--iterations", "8"));
const REAL = flag("--real");
const JSON_OUT = opt("--json", "");
// Extra args appended to the loop's commands, so one bench file can compare
// an old flow and a new one: e.g. --navigate-args "--wait load".
const NAV_ARGS = opt("--navigate-args", "").split(" ").filter(Boolean);
const WAIT_AFTER_NAV = !flag("--no-wait-step");

const HOME = mkdtempSync(path.join(tmpdir(), "chrome-relay-loop-home-"));
const cleanups = [];

function cli(args) {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_JS, ...args],
      { env: { ...process.env, CHROME_RELAY_HOME: HOME }, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ms: performance.now() - started,
          ok: !error,
          stdout: String(stdout),
          stderr: String(stderr)
        });
      }
    );
  });
}

async function mustCli(args) {
  const r = await cli(args);
  if (!r.ok) throw new Error(`cli ${args.join(" ")} failed: ${r.stderr || r.stdout}`.replace(/\n\s*/g, " "));
  return r;
}

// ---------------------------------------------------------------------------
// Fixture server: pages with a realistic shape — fast HTML, a slow
// subresource holding the load event (ads, analytics, hero image), a list
// big enough to make the AX tree non-trivial, a form, and a Next link.

function pageHtml(n, items, slowMs) {
  const rows = Array.from({ length: items }, (_, i) =>
    `<li class="row"><a href="/item/${i}">Item ${i} title text</a> <span>by user${i}</span> <button>Save ${i}</button></li>`
  ).join("\n");
  return `<!doctype html><html><head><title>Page ${n}</title>
<script src="/slow.js?ms=${Math.round(slowMs / 2)}" async></script>
</head><body>
<header><nav><a href="/">Home</a> <a id="next" href="/page?n=${n + 1}&items=${items}&slow=${slowMs}">Next page</a></nav></header>
<main>
<h1>Page ${n}</h1>
<form><label>Search <input name="q" type="search"></label><button type="submit">Go</button></form>
<ul>${rows}</ul>
<div class="card" style="cursor:pointer" onclick="this.dataset.clicked=1">Open card</div>
<img src="/slow.png?ms=${slowMs}" width="10" height="10" alt="hero">
</main></body></html>`;
}

function serveFixtures() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const ms = Number(u.searchParams.get("ms") ?? "0");
    if (u.pathname === "/page") {
      const n = Number(u.searchParams.get("n") ?? "1");
      const items = Number(u.searchParams.get("items") ?? "200");
      const slow = Number(u.searchParams.get("slow") ?? "1200");
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(pageHtml(n, items, slow));
      return;
    }
    if (u.pathname === "/slow.js") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        res.end("window.__slow = 1;");
      }, ms);
      return;
    }
    if (u.pathname === "/slow.png") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
        res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
      }, ms);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>ok</title><p>ok</p>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cleanups.push(() => server.close());
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function launchProfile() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "chrome-relay-loop-profile-"));
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
      description: "chrome-relay agent-loop bench host",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    })
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
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

function descriptor() {
  try {
    const dir = path.join(HOME, "instances");
    const name = readdirSync(dir).find((n) => n.endsWith(".json"));
    return name ? JSON.parse(readFileSync(path.join(dir, name), "utf8")) : null;
  } catch {
    return null;
  }
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function httpCall(desc, name, args) {
  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${desc.port}/call`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${desc.token}` },
    body: JSON.stringify({ name, args })
  });
  const body = await res.json();
  return { ms: performance.now() - started, body };
}

// ---------------------------------------------------------------------------
// Stats

const samples = new Map();
function record(step, ms) {
  if (!samples.has(step)) samples.set(step, []);
  samples.get(step).push(ms);
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p90 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
};

function findRef(snapshotText, pattern) {
  for (const line of snapshotText.split("\n")) {
    if (pattern.test(line)) {
      const m = /ref=([^\],\s]+)/.exec(line);
      if (m) return m[1];
    }
  }
  return null;
}

// One agent loop on one page: open → ready → look → act → ready → look.
async function agentLoop(label, url, nextPattern) {
  const t0 = performance.now();
  const nav = await mustCli(["navigate", url, "--new", ...NAV_ARGS]);
  record(`${label}: navigate --new`, nav.ms);
  const tabId = JSON.parse(nav.stdout).tabId;

  if (WAIT_AFTER_NAV) {
    const w = await mustCli(["wait", "--tab", String(tabId), "--load", "load", "--timeout", "20000"]);
    record(`${label}: wait --load load`, w.ms);
  }

  const snap = await mustCli(["snapshot", "--tab", String(tabId), "-i"]);
  if (process.env.BENCH_DUMP) console.log(`--- ${label} snapshot head:\n${snap.stdout.slice(0, 300)}`);
  record(`${label}: snapshot -i`, snap.ms);
  record(`${label}: snapshot bytes`, snap.stdout.length);

  const ref = nextPattern ? findRef(snap.stdout, nextPattern) : null;
  if (ref) {
    const c = await mustCli(["click", `@${ref}`]);
    record(`${label}: click @ref`, c.ms);
    if (WAIT_AFTER_NAV) {
      const w2 = await mustCli(["wait", "--tab", String(tabId), "--load", "load", "--timeout", "20000"]);
      record(`${label}: wait after click`, w2.ms);
    }
    const s2 = await mustCli(["snapshot", "--tab", String(tabId), "-i"]);
    record(`${label}: snapshot after click`, s2.ms);
  }
  record(`${label}: LOOP TOTAL`, performance.now() - t0);
  await cli(["close", String(tabId)]);
}

async function main() {
  console.log(`agent-loop bench — ${ITERATIONS} iterations${REAL ? " (+ real sites)" : ""}`);
  await launchProfile();
  const desc = await waitFor(descriptor, "instance descriptor");
  // Let the SW settle (first connect, storage hydration) before timing.
  await waitFor(async () => (await cli(["tabs"])).ok, "first successful call");
  const base = await serveFixtures();

  // Overhead probes.
  for (let i = 0; i < 15; i++) {
    record("overhead: cli tabs", (await mustCli(["tabs"])).ms);
    record("overhead: http tabs", (await httpCall(desc, "get_windows_and_tabs", {})).ms);
  }

  const fixture = `${base}/page?n=1&items=200&slow=1200`;
  const bigFixture = `${base}/page?n=1&items=1500&slow=300`;
  for (let i = 0; i < ITERATIONS; i++) {
    for (const [label, url] of [["fixture-200", fixture], ["fixture-1500", bigFixture]]) {
      try {
        await agentLoop(label, url, /link "Next page"/);
      } catch (e) {
        record(`${label}: FAILED`, 1);
        if (i === 0) console.log(`  ${label}: ${e.message.split("\n").slice(0, 2).join(" | ")}`);
      }
    }
  }

  if (REAL) {
    const real = [
      ["hn", "https://news.ycombinator.com/", /link "More"/],
      ["wikipedia", "https://en.wikipedia.org/wiki/Google_Chrome", null],
      ["github", "https://github.com/microsoft/playwright", null]
    ];
    for (let i = 0; i < Math.min(ITERATIONS, 4); i++) {
      for (const [label, url, next] of real) {
        try {
          await agentLoop(label, url, next);
        } catch (e) {
          console.log(`  ${label}: ${e.message.split("\n")[0]}`);
        }
      }
    }
  }

  const rows = [...samples.entries()].map(([step, xs]) => ({
    step,
    n: xs.length,
    median: Math.round(median(xs)),
    p90: Math.round(p90(xs))
  }));
  const width = Math.max(...rows.map((r) => r.step.length));
  console.log(`\n${"step".padEnd(width)}  ${"median".padStart(8)}  ${"p90".padStart(8)}   n`);
  for (const r of rows) {
    const unit = r.step.endsWith("bytes") ? "B " : "ms";
    console.log(`${r.step.padEnd(width)}  ${String(r.median).padStart(6)}${unit}  ${String(r.p90).padStart(6)}${unit}  ${r.n}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const fn of cleanups.reverse()) await fn();
    rmSync(HOME, { recursive: true, force: true });
  });
