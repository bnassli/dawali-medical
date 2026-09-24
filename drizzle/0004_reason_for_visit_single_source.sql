-- Reason for Visit: single authoritative source (Sprint 2, ADR-024).
--
-- Before: visits.reason (free text) and the clinical field reason_for_visit
-- could both hold a value. After: clinical_entries (field reason_for_visit)
-- is the ONLY source. This migration, in ONE transaction:
--   1. LOCKs visits and clinical_entries (SHARE ROW EXCLUSIVE: blocks every
--      concurrent INSERT/UPDATE/DELETE, so old application code cannot write
--      visits.reason or a reason entry while we backfill, verify and install the
--      trigger; plain reads continue). The drizzle migrator applies all pending
--      migrations inside one transaction, which LOCK TABLE requires.
--   2. ensures the section / option list / global field definition / placement
--      rows for reason_for_visit exist (the seed upserts the same rows and
--      refuses to change their structure, so both must agree),
--   3. snapshots every non-empty legacy reason once (trimmed the way the
--      application trims) and ABORTS with a clear error if any trimmed reason
--      is longer than 5000 characters (Unicode code points, the application
--      limit MAX_FREE_TEXT_LENGTH). Nothing is ever truncated; visits.reason is not
--      modified. Fix or shorten the reported rows by hand and re-run,
--   4. records a "clinical_entry.backfill_skipped" audit row, preserving the raw
--      legacy text, for EVERY non-empty legacy reason whose visit already had a
--      reason_for_visit entry (identical text or not, any version),
--   5. backfills the remaining non-empty legacy reasons as version 1
--      ({"optionIds": [], "freeText": <trimmed>}) with a
--      "clinical_entry.backfill" audit row carrying the raw legacy value,
--   6. VERIFIES every non-empty legacy reason now has a reason_for_visit entry
--      (aborts the whole migration otherwise),
--   7. makes visits.reason read-only with a trigger.
-- visits.reason is NOT dropped: it stays as a deprecated legacy column for
-- rollback safety and is to be removed by a later migration after production
-- validation. Every statement is idempotent (re-running changes nothing).
--
-- Rollback plan: `DROP TRIGGER IF EXISTS visits_reason_read_only ON visits;`
-- then `DROP FUNCTION IF EXISTS visits_reason_read_only();`. visits.reason was
-- never modified, so no data needs restoring. The backfilled clinical_entries
-- and audit rows are append-only history and are intentionally kept.

LOCK TABLE visits, clinical_entries IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO clinical_sections (code, name, sort_order)
VALUES ('subj_complaints_habits', 'Subj Complaints Habits', 1)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO clinical_option_lists (code, name)
VALUES ('reason_for_visit', 'Reason for Visit')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO clinical_field_definitions
  (code, label, field_type, option_list_id, allows_free_text, is_active)
SELECT 'reason_for_visit', 'Reason for Visit', 'select', l.id, true, true
FROM clinical_option_lists l
WHERE l.code = 'reason_for_visit'
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO clinical_section_fields (section_id, field_definition_id, sort_order)
SELECT s.id, f.id, 1
FROM clinical_sections s, clinical_field_definitions f
WHERE s.code = 'subj_complaints_habits' AND f.code = 'reason_for_visit'
ON CONFLICT (section_id, field_definition_id) DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM clinical_field_definitions
    WHERE code = 'reason_for_visit' AND allows_free_text AND field_type IN ('select', 'multiselect', 'text', 'textarea')
  ) THEN
    RAISE EXCEPTION 'reason_for_visit field definition exists but cannot hold free text; refusing to backfill legacy reasons into it';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE TEMP TABLE _legacy_reason ON COMMIT DROP AS
SELECT v.id AS visit_id,
       v.patient_id,
       v.created_by,
       v.reason AS raw_reason,
       t.trimmed,
       char_length(t.trimmed) AS char_count
FROM visits v
CROSS JOIN LATERAL (
  SELECT regexp_replace(
    v.reason,
    '^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
    '', 'g') AS trimmed
) t
WHERE v.reason IS NOT NULL AND t.trimmed <> '';
--> statement-breakpoint
DO $$
DECLARE
  too_long integer;
  sample text;
BEGIN
  SELECT count(*) INTO too_long FROM _legacy_reason WHERE char_count > 5000;
  SELECT string_agg(visit_id::text, ', ') INTO sample
  FROM (SELECT visit_id FROM _legacy_reason WHERE char_count > 5000 ORDER BY visit_id LIMIT 5) s;
  IF too_long > 0 THEN
    RAISE EXCEPTION 'reason_for_visit backfill aborted: % visit(s) have a legacy visits.reason longer than 5000 characters (e.g. visit ids: %). Nothing was truncated or modified. Shorten or move those values manually, then re-run the migration.',
      too_long, sample;
  END IF;
END;
$$;
--> statement-breakpoint
INSERT INTO audit_logs
  (actor_user_id, action, entity_type, entity_id, patient_id, visit_id, before, after, metadata)
SELECT NULL, 'clinical_entry.backfill_skipped', 'clinical_entry', e.id::text,
       l.patient_id, l.visit_id, NULL,
       jsonb_build_object('version', e.version, 'value', e.value),
       jsonb_build_object(
         'source', 'visits.reason',
         'migration', '0004_reason_for_visit_single_source',
         'fieldCode', 'reason_for_visit',
         'legacyValue', l.raw_reason,
         'existingVersion', e.version,
         'identicalToExisting',
           (jsonb_array_length(e.value->'optionIds') = 0 AND e.value->>'freeText' = l.trimmed),
         'note', 'visit already had a reason_for_visit entry; no entry was written and the legacy value is preserved here')
FROM _legacy_reason l
JOIN LATERAL (
  SELECT ce.*
  FROM clinical_entries ce
  JOIN clinical_field_definitions f ON f.id = ce.field_definition_id
  WHERE ce.visit_id = l.visit_id AND f.code = 'reason_for_visit'
  ORDER BY ce.version DESC
  LIMIT 1
) e ON true
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs a
  WHERE a.visit_id = l.visit_id
    AND a.action IN ('clinical_entry.backfill', 'clinical_entry.backfill_skipped')
    AND a.metadata->>'source' = 'visits.reason'
);
--> statement-breakpoint
WITH inserted AS (
  INSERT INTO clinical_entries (visit_id, field_definition_id, version, value, created_by)
  SELECT l.visit_id, f.id, 1,
         jsonb_build_object('optionIds', '[]'::jsonb, 'freeText', l.trimmed),
         l.created_by
  FROM _legacy_reason l
  CROSS JOIN clinical_field_definitions f
  WHERE f.code = 'reason_for_visit'
    AND NOT EXISTS (
      SELECT 1 FROM clinical_entries e
      WHERE e.visit_id = l.visit_id AND e.field_definition_id = f.id
    )
  RETURNING id, visit_id, value
)
INSERT INTO audit_logs
  (actor_user_id, action, entity_type, entity_id, patient_id, visit_id, before, after, metadata)
SELECT NULL, 'clinical_entry.backfill', 'clinical_entry', i.id::text,
       l.patient_id, i.visit_id, NULL,
       jsonb_build_object('version', 1, 'value', i.value),
       jsonb_build_object(
         'source', 'visits.reason',
         'migration', '0004_reason_for_visit_single_source',
         'fieldCode', 'reason_for_visit',
         'legacyValue', l.raw_reason,
         'visitCreatedBy', l.created_by)
FROM inserted i
JOIN _legacy_reason l ON l.visit_id = i.visit_id;
--> statement-breakpoint
DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
  FROM _legacy_reason l
  WHERE NOT EXISTS (
    SELECT 1
    FROM clinical_entries e
    JOIN clinical_field_definitions f ON f.id = e.field_definition_id
    WHERE e.visit_id = l.visit_id AND f.code = 'reason_for_visit'
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
