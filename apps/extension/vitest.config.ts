import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src")
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-chrome-mock.ts"],
    environmentMatchGlobs: [
      ["test/page-actions.test.ts", "jsdom"]
    ],
    environment: "node"
  }
});
