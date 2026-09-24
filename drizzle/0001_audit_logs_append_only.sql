-- Enforce append-only semantics on audit_logs at the database level.
-- Application code always inserts via writeAudit(); this trigger guarantees
-- that no code path (including a future bug, ad-hoc script, or direct DB
-- access) can silently rewrite or erase audit history (CLAUDE.md rule #8).
--
-- Rollback plan: `DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON audit_logs;`
-- followed by `DROP FUNCTION IF EXISTS audit_logs_prevent_update_delete();`
-- This rollback does not delete or alter any existing audit_logs rows.

CREATE OR REPLACE FUNCTION audit_logs_prevent_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION audit_logs_prevent_update_delete();
