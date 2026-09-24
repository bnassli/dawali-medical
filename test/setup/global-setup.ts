import "dotenv/config";
import { seed } from "../../src/db/seed";
import { startEmbeddedPostgres, type EmbeddedPostgresHandle } from "../../src/db/embedded";
import { runMigrations } from "../../src/db/migrator";

/**
 * Vitest global setup (runs once for the whole test run, before any test
 * file). Uses TEST_DATABASE_URL if set (e.g. in CI, where a real postgres
 * service container is provided — see .github/workflows/ci.yml); otherwise
 * spins up a throwaway `embedded-postgres` instance.
 *
 * Applies the real committed migration files (this doubles as migration
 * validation, per docs/TESTING.md) and seeds roles/permissions so tests can
 * create users against real, seeded roles.
 *
 * process.env.TEST_DATABASE_URL is (re)exported here so individual test
 * files can open their own connection to the same database — Vitest
 * propagates globalSetup's process.env mutations to test workers.
 */
let embedded: EmbeddedPostgresHandle | undefined;

export async function setup(): Promise<void> {
  let connectionString = process.env.TEST_DATABASE_URL;

  if (!connectionString) {
    embedded = await startEmbeddedPostgres("dawali_test");
    connectionString = embedded.connectionString;
    process.env.TEST_DATABASE_URL = connectionString;
  }

  await runMigrations(connectionString);
  await seed(connectionString);
}

export async function teardown(): Promise<void> {
  if (embedded) {
    await embedded.stop();
  }
}
