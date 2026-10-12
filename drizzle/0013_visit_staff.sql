-- ADR-039: doctor and nurse of a visit (users with the DOCTOR / NURSE_ASSISTANT role). Additive only.
-- Rollback: ALTER TABLE visits DROP COLUMN doctor_user_id, DROP COLUMN nurse_user_id;
-- (audit_logs keep every visit.staff change, so nothing is lost for the record).
ALTER TABLE "visits" ADD COLUMN "doctor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "nurse_user_id" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_doctor_user_id_users_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_nurse_user_id_users_id_fk" FOREIGN KEY ("nurse_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;