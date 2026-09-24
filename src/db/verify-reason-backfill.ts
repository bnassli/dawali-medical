import { sql } from "drizzle-orm";
import type { Database } from "./client";

/**
 * The whitespace the application's String.prototype.trim() removes, as a
 * PostgreSQL regex. Migration 0004 uses this exact string; a test asserts the
 * migration file contains it so the two can never drift apart.
 */
export const LEGACY_REASON_TRIM_REGEX =
  "^[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+|[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+$";

/** Same limit as the application (MAX_FREE_TEXT_LENGTH), counted in Unicode code points (characters). */
export const LEGACY_REASON_MAX_LENGTH = 5000;

export interface ReasonBackfillReport {
  /** Visits whose deprecated visits.reason is non-empty (after trimming). */
  legacyNonEmpty: number;
  /** Of those, visits with NO reason_for_visit clinical entry (must be 0). */
  missing: number;
  /** Of those, visits whose first entry differs from the legacy text (raw legacy text is kept in the audit log). */
  divergent: number;
  /** Of those, legacy values longer than the supported limit (the migration refuses to run while any exist). */
  overLimit: number;
}

/**
 * Verifies ADR-024's backfill: every non-empty legacy visits.reason must have
 * a reason_for_visit entry in clinical_entries. Read-only. `missing` must be
 * 0 before visits.reason may ever be dropped.
 */
export async function verifyLegacyReasonBackfill(db: Database): Promise<ReasonBackfillReport> {
  const result = await db.execute<{
    legacy: string;
    missing: string;
    divergent: string;
    over_limit: string;
  }>(sql`
    WITH reason_field AS (
      SELECT f.id FROM clinical_field_definitions f WHERE f.code = 'reason_for_visit'
    ),
    legacy AS (
      SELECT v.id, t.trimmed, char_length(t.trimmed) AS char_count
      FROM visits v
      CROSS JOIN LATERAL (
        SELECT regexp_replace(v.reason, ${LEGACY_REASON_TRIM_REGEX}, '', 'g') AS trimmed
      ) t
      WHERE v.reason IS NOT NULL AND t.trimmed <> ''
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
      count(*) FILTER (WHERE fe.visit_id IS NOT NULL AND fe.value->>'freeText' IS DISTINCT FROM l.trimmed) AS divergent,
      count(*) FILTER (WHERE l.char_count > ${LEGACY_REASON_MAX_LENGTH}) AS over_limit
    FROM legacy l
    LEFT JOIN first_entry fe ON fe.visit_id = l.id
  `);
  const row = result.rows[0];
  return {
    legacyNonEmpty: Number(row?.legacy ?? 0),
    missing: Number(row?.missing ?? 0),
    divergent: Number(row?.divergent ?? 0),
    overLimit: Number(row?.over_limit ?? 0),
  };
}
