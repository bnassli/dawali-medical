import { sql } from "drizzle-orm";
import type { Database } from "./client";

export interface ReasonBackfillReport {
  /** Visits whose deprecated visits.reason is non-empty. */
  legacyNonEmpty: number;
  /** Of those, visits with NO reason_for_visit clinical entry (must be 0). */
  missing: number;
  /** Of those, visits whose entry differs from the legacy text (legacy value kept in the audit log). */
  divergent: number;
}

/**
 * Verifies ADR-024's backfill: every non-empty legacy visits.reason must have
 * a reason_for_visit entry in clinical_entries. Read-only. `missing` must be
 * 0 before visits.reason may ever be dropped.
 */
export async function verifyLegacyReasonBackfill(db: Database): Promise<ReasonBackfillReport> {
  const result = await db.execute<{ legacy: string; missing: string; divergent: string }>(sql`
    WITH reason_field AS (
      SELECT f.id
      FROM clinical_field_definitions f
      JOIN clinical_sections s ON s.id = f.section_id
      WHERE s.code = 'subj_complaints_habits' AND f.code = 'reason_for_visit'
    ),
    legacy AS (
      SELECT v.id, btrim(v.reason) AS reason
      FROM visits v
      WHERE v.reason IS NOT NULL AND btrim(v.reason) <> ''
    ),
    first_entry AS (
      SELECT DISTINCT ON (e.visit_id) e.visit_id, e.value
      FROM clinical_entries e
      WHERE e.field_definition_id IN (SELECT id FROM reason_field)
      ORDER BY e.visit_id, e.version ASC
    )
    SELECT
      count(*) AS legacy,
      count(*) FILTER (WHERE fe.visit_id IS NULL) AS missing,
      count(*) FILTER (WHERE fe.visit_id IS NOT NULL AND fe.value->>'freeText' IS DISTINCT FROM l.reason) AS divergent
    FROM legacy l
    LEFT JOIN first_entry fe ON fe.visit_id = l.id
  `);
  const row = result.rows[0];
  return {
    legacyNonEmpty: Number(row?.legacy ?? 0),
    missing: Number(row?.missing ?? 0),
    divergent: Number(row?.divergent ?? 0),
  };
}
