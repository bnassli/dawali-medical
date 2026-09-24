import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getDatabaseUrl } from "@/lib/env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Database | undefined;

/**
 * Lazily create the connection pool + drizzle instance. Lazy so that
 * importing this module (e.g. transitively during `next build`) never opens
 * a socket or requires DATABASE_URL to be set at build time.
 */
export function getDb(): Database {
  if (!db) {
    pool = new Pool({ connectionString: getDatabaseUrl() });
    db = drizzle(pool, { schema });
  }
  return db;
}

/**
 * Create a standalone drizzle instance + pool for a given connection string.
 * Used by tests / scripts that manage their own (often ephemeral) database
 * rather than the app's singleton pool.
 */
export function createDb(connectionString: string): {
  db: Database;
  pool: Pool;
} {
  const testPool = new Pool({ connectionString });
  return { db: drizzle(testPool, { schema }), pool: testPool };
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
