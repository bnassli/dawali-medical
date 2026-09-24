-- R1a: V1 patient demographics (ADR-028). Additive only.
--   * demographic_options: configurable Nationality / Preferred Language lists.
--   * patients: nationality/preferred-language references, insurance_id (NOT
--     unique), is_active, emergency contact, version (optimistic concurrency).
--   * patients.sex normalised to 'F' | 'M' | NULL, then constrained by CHECK.
--
-- Sex normalisation (runs after the ALTER TABLEs above, so patients is already
-- held under ACCESS EXCLUSIVE lock for the rest of the migration transaction):
--   'f'/'female' -> 'F', 'm'/'male' -> 'M' (trimmed, case-insensitive),
--   blank -> NULL. Each changed row gets an append-only audit row
--   "patient.sex_normalized" with the raw before value. If ANY other value is
--   present the migration ABORTS (nothing is guessed or changed): fix those rows
--   by hand to F / M / NULL and re-run.
--
-- Rollback plan:
--   ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_sex_check;
--   ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_nationality_option_id_demographic_options_id_fk,
--     DROP CONSTRAINT IF EXISTS patients_preferred_language_option_id_demographic_options_id_fk;
--   DROP INDEX IF EXISTS patients_insurance_id_lower_idx;
--   ALTER TABLE patients DROP COLUMN nationality_option_id, DROP COLUMN preferred_language_option_id,
--     DROP COLUMN insurance_id, DROP COLUMN is_active, DROP COLUMN emergency_contact_name,
--     DROP COLUMN emergency_contact_phone, DROP COLUMN emergency_contact_relationship, DROP COLUMN version;
--   DROP TABLE demographic_options;
-- Dropping the columns DESTROYS the new demographic data: take a verified backup
-- first. The normalised sex values are not reverted automatically; the original
-- raw values are preserved in the patient.sex_normalized audit rows
-- (before->>'sex') and can be restored from there if ever required.

CREATE TABLE "demographic_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_code" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demographic_options_list_code_check" CHECK ("demographic_options"."list_code" IN ('nationality', 'preferred_language'))
);
--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "nationality_option_id" uuid;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "preferred_language_option_id" uuid;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "insurance_id" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "emergency_contact_name" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "emergency_contact_phone" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "emergency_contact_relationship" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "demographic_options" ADD CONSTRAINT "demographic_options_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demographic_options_list_lower_label_idx" ON "demographic_options" USING btree ("list_code",lower("label"));--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_nationality_option_id_demographic_options_id_fk" FOREIGN KEY ("nationality_option_id") REFERENCES "public"."demographic_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_preferred_language_option_id_demographic_options_id_fk" FOREIGN KEY ("preferred_language_option_id") REFERENCES "public"."demographic_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patients_insurance_id_lower_idx" ON "patients" USING btree (lower("insurance_id"));--> statement-breakpoint
DO $$
DECLARE
  bad_count integer;
  bad_ids text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ' ORDER BY id)
    INTO bad_count, bad_ids
  FROM patients
  WHERE sex IS NOT NULL
    AND lower(btrim(sex)) NOT IN ('', 'f', 'female', 'm', 'male');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration 0006 aborted: % patient(s) have an unrecognised sex value (expected F, M, female, male or blank). Fix them to F / M / NULL and re-run. Patient ids: %', bad_count, bad_ids;
  END IF;
END
$$;--> statement-breakpoint
INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, patient_id, before, after, metadata)
SELECT NULL, 'patient.sex_normalized', 'patient', p.id::text, p.id,
       jsonb_build_object('sex', p.sex),
       jsonb_build_object('sex', n.normalized),
       jsonb_build_object('migration', '0006_patient_v1_demographics')
FROM patients p
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN lower(btrim(p.sex)) IN ('f', 'female') THEN 'F'
    WHEN lower(btrim(p.sex)) IN ('m', 'male') THEN 'M'
    ELSE NULL
  END AS normalized
) n
WHERE p.sex IS NOT NULL AND p.sex IS DISTINCT FROM n.normalized;--> statement-breakpoint
UPDATE patients
SET sex = CASE
    WHEN lower(btrim(sex)) IN ('f', 'female') THEN 'F'
    WHEN lower(btrim(sex)) IN ('m', 'male') THEN 'M'
    ELSE NULL
  END
WHERE sex IS NOT NULL
  AND sex IS DISTINCT FROM (CASE
    WHEN lower(btrim(sex)) IN ('f', 'female') THEN 'F'
    WHEN lower(btrim(sex)) IN ('m', 'male') THEN 'M'
    ELSE NULL
  END);--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_sex_check" CHECK ("patients"."sex" IN ('F', 'M'));