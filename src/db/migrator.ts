import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

/**
 * Applies all committed SQL migrations in ./drizzle to the database pointed
 * at by the given connection string. Safe to run repeatedly (drizzle tracks
 * applied migrations in its own bookkeeping table:
 * drizzle.__drizzle_migrations).
 *
 * Used by the `db:migrate` CLI script, `db:validate`, and the test global
 * setup (which runs the same real migration files against a fresh
 * database — this doubles as migration validation, per TESTING.md).
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString);
  try {
    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
  } finally {
    await pool.end();
  }
}
