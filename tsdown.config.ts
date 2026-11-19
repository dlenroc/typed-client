import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/fetch.ts", "src/playwright.ts", "src/k6.ts"],
  format: "esm",
  platform: "neutral",
  target: "es2022",
  deps: { neverBundle: ["k6/http", "node:buffer"] },
  // Shared chunks keep their module names and export names, so
  // go-to-definition lands on `types.d.ts` and `ResponseHeaders`.
  hash: false,
  outputOptions: { minifyInternalExports: false },
});
