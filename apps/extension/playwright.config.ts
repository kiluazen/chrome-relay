import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e/specs",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  }
});
