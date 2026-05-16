import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer, type FixtureServer } from "./fixture-server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EXTENSION_PATH = resolve(__dirname, "..", "..", "..", "build", "chrome-mv3");

if (!existsSync(EXTENSION_PATH)) {
  throw new Error(
    `Built extension not found at ${EXTENSION_PATH}. Run \`pnpm --filter chrome-relay-extension build\` first.`
  );
}

interface WorkerFixtures {
  extensionContext: BrowserContext;
  serviceWorker: Worker;
  fixtures: FixtureServer;
}

interface TestFixtures {
  runTool: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  openFixture: (name: string) => Promise<{ tabId: number; url: string }>;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  extensionContext: [
    async ({}, use) => {
      const userDataDir = mkdtempSync(join(tmpdir(), "chrome-relay-e2e-"));
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          "--no-first-run",
          "--no-default-browser-check"
        ]
      });
      await use(context);
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
    { scope: "worker" }
  ],

  serviceWorker: [
    async ({ extensionContext }, use) => {
      let [worker] = extensionContext.serviceWorkers();
      if (!worker) {
        worker = await extensionContext.waitForEvent("serviceworker", { timeout: 30_000 });
      }
      await worker.evaluate(async () => {
        const start = Date.now();
        while (!(globalThis as { __chromeRelay?: unknown }).__chromeRelay) {
          if (Date.now() - start > 10_000) throw new Error("__chromeRelay never appeared");
          await new Promise((r) => setTimeout(r, 50));
        }
      });
      await use(worker);
    },
    { scope: "worker" }
  ],

  fixtures: [
    async ({}, use) => {
      const server = await startFixtureServer();
      await use(server);
      await server.close();
    },
    { scope: "worker" }
  ],

  runTool: async ({ serviceWorker }, use) => {
    const callTool = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
      return (await serviceWorker.evaluate(
        async ({ name: toolName, args: toolArgs }) => {
          const relay = (globalThis as {
            __chromeRelay?: { runTool: (n: string, a: unknown) => Promise<unknown> };
          }).__chromeRelay;
          if (!relay) throw new Error("__chromeRelay not exposed in service worker");
          return relay.runTool(toolName, toolArgs);
        },
        { name, args }
      )) as T;
    };
    await use(callTool);
  },

  openFixture: async ({ extensionContext, fixtures, serviceWorker }, use) => {
    const opened: number[] = [];
    const open = async (name: string): Promise<{ tabId: number; url: string }> => {
      const url = fixtures.url("/" + name);
      const page = await extensionContext.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const tabId = (await serviceWorker.evaluate(async (matchUrl) => {
        const tabs = await chrome.tabs.query({ url: matchUrl });
        return tabs[0]?.id ?? null;
      }, url)) as number | null;
      if (tabId === null) throw new Error(`No tab id for ${url}`);
      opened.push(tabId);
      return { tabId, url };
    };
    await use(open);
    if (opened.length) {
      await serviceWorker.evaluate(async (ids) => {
        for (const id of ids) {
          try { await chrome.tabs.remove(id); } catch { /* already closed */ }
        }
      }, opened);
    }
  }
});

export { expect } from "@playwright/test";
