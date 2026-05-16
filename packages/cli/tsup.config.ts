import { defineConfig } from "tsup";

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
});
