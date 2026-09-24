-- R1b (ADR-029): presentation-only visual group of a field placement, e.g.
-- "Habits" in Subj Complaints Habits. Nullable, additive, no data migration; the
-- seed sets it from `groups` in src/modules/clinical/definitions.ts.
--
-- Rollback plan: ALTER TABLE clinical_section_fields DROP COLUMN group_label;
-- Drops only presentation headings (re-created by re-seeding after the column is
-- re-added). No clinical data is touched.

ALTER TABLE "clinical_section_fields" ADD COLUMN "group_label" text;