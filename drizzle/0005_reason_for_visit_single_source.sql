-- Reason for Visit: single authoritative source (Sprint 2, ADR-024).
--
-- Before: visits.reason (free text) and the clinical field reason_for_visit
-- could both hold a value. After: clinical_entries (field reason_for_visit)
-- is the ONLY source. This migration
--   1. ensures the section / option list / field definition exist (the seed
--      upserts the same rows, so this is idempotent and order-independent),
--   2. backfills every non-empty visits.reason into clinical_entries as
--      version 1 ({"optionIds": [], "freeText": <trimmed legacy text>}) with a
--      "clinical_entry.backfill" audit row carrying the raw legacy value,
--   3. records a "clinical_entry.backfill_skipped" audit row (raw legacy value
--      preserved) when a visit already has a reason_for_visit entry, so no
--      legacy value is ever silently discarded,
--   4. VERIFIES that every non-empty legacy value has a reason_for_visit
--      entry and aborts (rolls the migration back) otherwise,
--   5. makes visits.reason read-only at the database level.
-- visits.reason is NOT dropped: it stays as a deprecated legacy column for
-- rollback safety and is to be removed by a later migration after production
-- validation. Every statement is idempotent (re-running changes nothing).
--
-- Rollback plan: `DROP TRIGGER IF EXISTS visits_reason_read_only ON visits;`
-- then `DROP FUNCTION IF EXISTS visits_reason_read_only();`. visits.reason was
-- never modified, so no data needs restoring. The backfilled clinical_entries
-- and audit rows are append-only history and are intentionally kept.

INSERT INTO clinical_sections (code, name, sort_order)
VALUES ('subj_complaints_habits', 'Subj Complaints Habits', 1)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO clinical_option_lists (code, name)
VALUES ('subj_complaints_habits.reason_for_visit', 'Reason for Visit')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO clinical_field_definitions
  (section_id, code, label, field_type, option_list_id, allows_free_text, sort_order, is_active)
SELECT s.id, 'reason_for_visit', 'Reason for Visit', 'select', l.id, true, 1, true
FROM clinical_sections s, clinical_option_lists l
WHERE s.code = 'subj_complaints_habits'
  AND l.code = 'subj_complaints_habits.reason_for_visit'
ON CONFLICT (section_id, code) DO NOTHING;
--> statement-breakpoint
WITH legacy AS (
  SELECT v.id AS visit_id, v.patient_id, v.created_by, v.reason AS raw_reason,
         btrim(v.reason) AS reason, f.id AS field_id
  FROM visits v
  CROSS JOIN clinical_field_definitions f
  JOIN clinical_sections s ON s.id = f.section_id
  WHERE s.code = 'subj_complaints_habits'
    AND f.code = 'reason_for_visit'
    AND v.reason IS NOT NULL
    AND btrim(v.reason) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM clinical_entries e
      WHERE e.visit_id = v.id AND e.field_definition_id = f.id
    )
), inserted AS (
  INSERT INTO clinical_entries (visit_id, field_definition_id, version, value, created_by)
  SELECT visit_id, field_id, 1,
         jsonb_build_object('optionIds', '[]'::jsonb, 'freeText', reason),
         created_by
  FROM legacy
  RETURNING id, visit_id, value, created_by
)
INSERT INTO audit_logs
  (actor_user_id, action, entity_type, entity_id, patient_id, visit_id, before, after, metadata)
SELECT i.created_by, 'clinical_entry.backfill', 'clinical_entry', i.id::text,
       l.patient_id, i.visit_id, NULL,
       jsonb_build_object('version', 1, 'value', i.value),
       jsonb_build_object(
         'source', 'visits.reason',
         'migration', '0005_reason_for_visit_single_source',
         'fieldCode', 'reason_for_visit',
         'legacyValue', l.raw_reason)
FROM inserted i
JOIN legacy l ON l.visit_id = i.visit_id;
--> statement-breakpoint
INSERT INTO audit_logs
  (actor_user_id, action, entity_type, entity_id, patient_id, visit_id, before, after, metadata)
SELECT NULL, 'clinical_entry.backfill_skipped', 'clinical_entry', e.id::text,
       v.patient_id, v.id, NULL, e.value,
       jsonb_build_object(
         'source', 'visits.reason',
         'migration', '0005_reason_for_visit_single_source',
         'fieldCode', 'reason_for_visit',
         'legacyValue', v.reason,
         'note', 'visit already had a reason_for_visit entry; legacy value preserved here')
FROM visits v
JOIN clinical_entries e ON e.visit_id = v.id AND e.version = 1
JOIN clinical_field_definitions f ON f.id = e.field_definition_id AND f.code = 'reason_for_visit'
JOIN clinical_sections s ON s.id = f.section_id AND s.code = 'subj_complaints_habits'
WHERE v.reason IS NOT NULL
  AND btrim(v.reason) <> ''
  AND e.value->>'freeText' IS DISTINCT FROM btrim(v.reason)
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs a
    WHERE a.action IN ('clinical_entry.backfill', 'clinical_entry.backfill_skipped')
      AND a.visit_id = v.id
      AND a.metadata->>'source' = 'visits.reason'
  );
--> statement-breakpoint
DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
  FROM visits v
  WHERE v.reason IS NOT NULL
    AND btrim(v.reason) <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM clinical_entries e
      JOIN clinical_field_definitions f ON f.id = e.field_definition_id
      JOIN clinical_sections s ON s.id = f.section_id
      WHERE e.visit_id = v.id
        AND f.code = 'reason_for_visit'
        AND s.code = 'subj_complaints_habits'
    );
  IF missing > 0 THEN
    RAISE EXCEPTION 'reason_for_visit backfill verification failed: % visit(s) with a non-empty legacy reason have no clinical entry', missing;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION visits_reason_read_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.reason IS NOT NULL THEN
    RAISE EXCEPTION 'visits.reason is deprecated and read-only; Reason for Visit lives in clinical_entries';
  ELSIF TG_OP = 'UPDATE' AND NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'visits.reason is deprecated and read-only; Reason for Visit lives in clinical_entries';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS visits_reason_read_only ON visits;
--> statement-breakpoint
CREATE TRIGGER visits_reason_read_only
BEFORE INSERT OR UPDATE ON visits
FOR EACH ROW
EXECUTE FUNCTION visits_reason_read_only();
