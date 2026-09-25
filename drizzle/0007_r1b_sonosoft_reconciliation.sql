-- R1b: reconcile clinical tabs with the SonoSoft reference screens (ADR-029).
-- Configuration only: no clinical entry is inserted, updated or deleted, and
-- every statement is idempotent (safe to re-run). On a fresh database the
-- affected fields do not exist yet, so every statement is a no-op there and
-- the seed creates the new structure. Rollback: see docs/DATABASE.md (0007).

-- 1. Retire fields replaced by R1b. Their history stays visible read-only on
--    visits that have it (ADR-026); they can no longer be written.
UPDATE "clinical_field_definitions"
SET "is_active" = false
WHERE "code" IN ('past_medical_unknown', 'impression', 'recommendations', 'stockings_measurements')
  AND "is_active" = true;
--> statement-breakpoint

-- 2. Show retired fields after the live ones in their tab.
UPDATE "clinical_section_fields" AS sf
SET "sort_order" = 900 + sf."sort_order"
FROM "clinical_field_definitions" AS f
WHERE f."id" = sf."field_definition_id"
  AND f."code" IN ('past_medical_unknown', 'impression', 'recommendations', 'stockings_measurements')
  AND sf."sort_order" < 900;
--> statement-breakpoint

-- 3. S1: Subj asks the separate "Family history of VV?" question (new field
--    family_history_vv, created by the seed). The general family history is
--    shown only in Past Medical Hx. Removing the placement does not touch any
--    entry: family_history values stay visible in Past Medical Hx.
DELETE FROM "clinical_section_fields" AS sf
USING "clinical_sections" AS s, "clinical_field_definitions" AS f
WHERE sf."section_id" = s."id"
  AND sf."field_definition_id" = f."id"
  AND s."code" = 'subj_complaints_habits'
  AND f."code" = 'family_history';
--> statement-breakpoint

-- 4. P3: Past Medical Hx "Additional Comments" is a dropdown with free text in
--    SonoSoft. The stored value shape ({ optionIds: [], freeText }) is the same
--    for textarea and select fields, so existing entries stay valid unchanged.
INSERT INTO "clinical_option_lists" ("code", "name")
SELECT 'past_medical_additional_comments', 'Additional Comments'
WHERE EXISTS (
  SELECT 1 FROM "clinical_field_definitions" WHERE "code" = 'past_medical_additional_comments'
)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

UPDATE "clinical_field_definitions"
SET "field_type" = 'select',
    "option_list_id" = (
      SELECT "id" FROM "clinical_option_lists" WHERE "code" = 'past_medical_additional_comments'
    )
WHERE "code" = 'past_medical_additional_comments'
  AND "field_type" = 'textarea';
