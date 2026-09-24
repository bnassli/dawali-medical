import "dotenv/config";
import { getDatabaseUrl } from "@/lib/env";
import { createDb } from "./client";
import { verifyLegacyReasonBackfill } from "./verify-reason-backfill";

/**
 * `npm run db:verify-reason-backfill` — run against production after the
 * Sprint 2 migrations. Exits 1 if any non-empty legacy visits.reason has no
 * reason_for_visit clinical entry. Read-only.
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(getDatabaseUrl());
  try {
    const report = await verifyLegacyReasonBackfill(db);
    console.log(
      `legacy non-empty reasons: ${report.legacyNonEmpty}; missing clinical entry: ${report.missing}; over limit: ${report.overLimit}; ` +
        `differs from legacy text (kept in audit log): ${report.divergent}`,
    );
    if (report.missing > 0) {
      console.error("FAILED: some legacy reasons were not backfilled. Do NOT drop visits.reason.");
      process.exitCode = 1;
    } else {
      console.log("OK: every non-empty legacy visits.reason has a reason_for_visit entry.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
