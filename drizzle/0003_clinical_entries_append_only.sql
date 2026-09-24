-- Enforce append-only semantics on clinical_entries at the database level.
-- Every clinical change is a new version row (ADR-008); no code path
-- (including a future bug or ad-hoc script) may rewrite or erase history
-- (CLAUDE.md medical history rules).
--
-- Rollback plan: `DROP TRIGGER IF EXISTS clinical_entries_no_update_delete ON clinical_entries;`
-- followed by `DROP FUNCTION IF EXISTS clinical_entries_prevent_update_delete();`
-- This rollback does not delete or alter any existing clinical_entries rows.
-- (Rolling back 0002_clinical_foundation.sql itself is a destructive DROP of
-- the clinical_* tables and must only be done on a database holding no
-- clinical data, or after a verified backup.)

CREATE OR REPLACE FUNCTION clinical_entries_prevent_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'clinical_entries is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER clinical_entries_no_update_delete
BEFORE UPDATE OR DELETE ON clinical_entries
FOR EACH ROW
EXECUTE FUNCTION clinical_entries_prevent_update_delete();
