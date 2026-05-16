import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

// Read package.json once at build time so the bundled CLI always reports the
// shipped version. Previously CHROME_RELAY_VERSION was hardcoded in src/index.ts
// and drifted (Issue #8 — `--version` reported 0.2.3 while the install was 0.3.1).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: [
    "src/cli.ts",
    "src/index.ts",
    "src/native-host.ts"
  ],
  format: "esm",
  dts: true,
  clean: true,
  splitting: false,
  noExternal: ["@chrome-relay/protocol"],
  define: {
    __CHROME_RELAY_VERSION__: JSON.stringify(pkg.version)
  }
});
