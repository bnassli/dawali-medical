import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // CLAUDE.md rule #5 / PROMPT_SPRINT_1: TypeScript strict, avoid `any`.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "drizzle/**",
    // Generated Playwright output (HTML report bundles), not source.
    "playwright-report/**",
    "test-results/**",
    // Local Claude Code state (worktrees, caches): never linted, never committed.
    ".claude/**",
  ]),
]);

export default eslintConfig;
