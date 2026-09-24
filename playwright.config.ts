import { defineConfig } from "@playwright/test";

/**
 * Browser E2E against the PRODUCTION build (`npm run build` first) served by
 * `next start`, backed by a real PostgreSQL (CI service container) or a local
 * PGlite server. Database: E2E_DATABASE_URL, else TEST_DATABASE_URL, else
 * DATABASE_URL. Locally set PW_CHANNEL=chrome (or msedge) to reuse an
 * installed browser; CI installs Playwright's own Chromium.
 *
 * No retries on purpose: a test that only passes on retry hides a race in the
 * autosave/conflict logic these tests exist to catch.
 */
const databaseUrl =
  process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    channel: process.env.PW_CHANNEL || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run start -- -p ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      NODE_ENV: "production",
    },
  },
});
