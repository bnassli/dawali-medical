import type { Config } from "drizzle-kit";

// drizzle-kit's own config loader runs outside our app's env validation, so
// we read process.env directly here with a safe fallback. `generate` never
// needs a live connection; `check`/`push` would, but we don't use those in
// Sprint 1 (db:validate uses the drizzle-orm migrator, not drizzle-kit push).
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/dawali_placeholder";

export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
} satisfies Config;
