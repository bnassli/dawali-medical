import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { startEmbeddedPostgres } from "./embedded";
import { runMigrations } from "./migrator";

const EXPECTED_TABLES = [
  "users",
  "roles",
  "permissions",
  "user_roles",
  "role_permissions",
  "sessions",
  "patients",
  "patient_external_ids",
  "visits",
  "audit_logs",
];

async function checkTablesExist(connectionString: string): Promise<string[]> {
  const { db, pool } = createDb(connectionString);
  try {
    const result = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const present = new Set(result.rows.map((r) => r.table_name));
    return EXPECTED_TABLES.filter((t) => !present.has(t));
  } finally {
    await pool.end();
  }
}

/**
 * Detects schema drift by running `drizzle-kit generate` against a scratch
 * copy of the migrations folder. If the current schema.ts no longer matches
 * the last committed migration snapshot, drizzle-kit will emit a new SQL
 * file — which means someone changed the schema without generating +
 * committing a migration for it.
 */
function checkNoSchemaDrift(): { drift: boolean; detail: string } {
  const scratchOut = mkdtempSync(path.join(tmpdir(), "dawali-drift-check-"));
  const drizzleDir = path.resolve(process.cwd(), "drizzle");
  cpSync(drizzleDir, scratchOut, { recursive: true });

  const before = new Set(readdirSync(scratchOut));

  execFileSync(
    "npx",
    [
      "drizzle-kit",
      "generate",
      "--schema",
      "./src/db/schema/index.ts",
      "--out",
      scratchOut,
      "--dialect",
      "postgresql",
    ],
    { cwd: process.cwd(), stdio: "pipe", shell: true },
  );

  const after = readdirSync(scratchOut);
  const newFiles = after.filter((f) => !before.has(f) && f.endsWith(".sql"));
  rmSync(scratchOut, { recursive: true, force: true });

  return {
    drift: newFiles.length > 0,
    detail:
      newFiles.length > 0
        ? `drizzle-kit generate produced new migration file(s) not present in drizzle/: ${newFiles.join(", ")}. Run "npm run db:generate" and commit the result.`
        : "No schema drift detected.",
  };
}

async function main() {
  let stop: (() => Promise<void>) | undefined;
  let connectionString = process.env.TEST_DATABASE_URL;
  let failed = false;

  try {
    if (!connectionString) {
      console.log("TEST_DATABASE_URL not set — starting embedded PostgreSQL...");
      const embedded = await startEmbeddedPostgres("dawali_validate");
      connectionString = embedded.connectionString;
      stop = embedded.stop;
    }

    console.log("Applying migrations from scratch...");
    await runMigrations(connectionString);

    console.log("Checking expected tables exist...");
    const missing = await checkTablesExist(connectionString);
    if (missing.length > 0) {
      failed = true;
      console.error(`Missing expected tables: ${missing.join(", ")}`);
    } else {
      console.log(`All ${EXPECTED_TABLES.length} expected tables are present.`);
    }

    console.log("Checking for schema drift (drizzle-kit generate)...");
    const drift = checkNoSchemaDrift();
    console.log(drift.detail);
    if (drift.drift) failed = true;
  } catch (err) {
    failed = true;
    console.error("db:validate failed with an error:", err);
  } finally {
    if (stop) await stop();
  }

  if (failed) {
    console.error("db:validate FAILED.");
    process.exit(1);
  }
  console.log("db:validate PASSED.");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("db:validate crashed:", err);
  process.exit(1);
});
