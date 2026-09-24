import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/setup/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // All test files share one database (started once in globalSetup), so
    // run them sequentially to avoid cross-test interference.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
