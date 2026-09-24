# Database — Initial Domain Model

Core:
- users
- roles
- permissions
- user_roles / role_permissions
- patients
- patient_external_ids
- visits

Clinical:
- clinical_sections
- clinical_field_definitions
- clinical_section_fields
- clinical_option_lists
- clinical_options
- clinical_entries

Procedures:
- treatment_plans
- treatment_plan_items
- procedures
- laser_ablations
- followups

Diagrams:
- diagram_templates
- diagrams
- diagram_versions

Reports:
- report_templates
- reports
- report_versions

Files:
- patient_files

Audit:
- audit_logs

Rules:
- Historical visits are never overwritten.
- Final reports are versioned/amended.
- Saved diagrams are versioned.
- Clinical deletion is soft/privileged and audited.

## Clinical tables as implemented (Sprint 2, ADR-026)

A clinical concept is defined ONCE (global field) and merely *placed* in tabs,
so it can never have two sources of truth.

| Table | Purpose / key columns |
|---|---|
| `clinical_sections` | A tab: `code` (unique), `name`, `sort_order`. |
| `clinical_field_definitions` | GLOBAL fields: `code` UNIQUE across the whole system, `label`, `field_type` (`select` \| `multiselect` \| `text` \| `textarea`), `option_list_id`, `allows_free_text`, `is_active`. No section, no order. The structural columns (`field_type`, `option_list_id`, `allows_free_text`) are never changed by the seed — a migration is required. |
| `clinical_section_fields` | Placement: (`section_id`, `field_definition_id`) primary key, `sort_order`. One field may be placed in many sections. Order follows `docs/CLINICAL_TABS.md`. |
| `clinical_option_lists` | `code` (unique), `name`. Independent of fields: several fields may share one list (default list code = the field's code). |
| `clinical_options` | `list_id`, `label`, `sort_order`, `is_active`, `created_by`. Unique on (`list_id`, `lower(label)`). Never renamed or deleted; retired via `is_active = false`. Starts EMPTY — values come from "+ Add New". |
| `clinical_entries` | Append-only revisions keyed by (visit, GLOBAL field): `visit_id`, `field_definition_id`, `version`, `value` (jsonb `{ optionIds: uuid[], freeText: string }`), `client_mutation_id` (uuid, nullable), `created_by`, `created_at`. Unique on (`visit_id`, `field_definition_id`, `version`) and on `client_mutation_id` where not null. The current value is the highest `version`. |

Triggers (all enforced in the database, not only in code):
- `audit_logs_no_update_delete` — audit log is append-only (0001).
- `clinical_entries_no_update_delete` — clinical history is append-only (0003).
- `visits_reason_read_only` — the deprecated `visits.reason` column rejects any change (0004).

### Reason for Visit (ADR-024)
The only authoritative, writable source is `clinical_entries` for the global
field `reason_for_visit`. `visits.reason` is a deprecated legacy column:
backfilled by migration 0004, read-only by trigger, never read or written by
application code, and to be dropped by a future migration after production
validation (`npm run db:verify-reason-backfill` must report `missing: 0`).

Length rule: free text and the intake reason are at most 5000 characters
(Unicode code points). Migration 0004 refuses to run — without truncating or
modifying anything — if any trimmed legacy reason is longer.

### Sprint 2 migrations
The Sprint 2 migrations had not been merged or deployed, so they were revised
in place (no compatibility stack). Apply them in order with `npm run db:migrate`,
then `npm run db:seed`.

| File | Change | Rollback |
|---|---|---|
| `0002_clinical_foundation.sql` | Creates the six clinical tables (global fields, placements, lists, options, entries incl. `client_mutation_id` and its partial unique index). | Destructive `DROP TABLE`s — only on a database with no clinical data or after a verified backup. |
| `0003_clinical_entries_append_only.sql` | Append-only trigger on `clinical_entries`. | Drop trigger + function; no data touched. |
| `0004_reason_for_visit_single_source.sql` | In one transaction: `LOCK TABLE visits, clinical_entries IN SHARE ROW EXCLUSIVE MODE` (blocks concurrent writers, incl. old application code); ensures the Reason for Visit field/placement rows; aborts if any trimmed legacy reason exceeds 5000 characters; audits `backfill_skipped` for every visit that already had a reason entry (identical or not); backfills the rest; verifies; installs the read-only trigger. Idempotent; pure ASCII. | Drop trigger + function; `visits.reason` was never modified. Backfilled entries/audit rows are history and stay. |

Deployment note for 0004: run it with the new application version. The lock
makes any old-code write to `visits`/`clinical_entries` wait until the migration
commits (and then hit the read-only trigger); there is no supported window in
which old code keeps writing `visits.reason`.

### Audit actions written by clinical code
`clinical_entry.create` (v1), `clinical_entry.update` (v2+, with before/after),
`clinical_entry.backfill`, `clinical_entry.backfill_skipped` (migration 0004; raw
legacy text preserved in `metadata.legacyValue`), `clinical_option.create`,
`clinical_option.update` (retire/reactivate), `access.denied` (see below).
Conflicts, replays and no-op saves write no audit row because they change nothing.

`access.denied` rows: `visit_id`/`patient_id` are foreign keys, so they are filled
only when the referenced row exists; ids that came from untrusted input and do
not exist (or are malformed) are recorded in `metadata.attempted` instead, so a
probe of a nonexistent id yields a normal 403 and a normal audit row. Extra
metadata: `requiredPermission`, or `reason: actor_mismatch` with
`expectedUserId`.

## Sprint 3A additions (ADR-027)

- `clinical_section_fields.label_override` (text, nullable, migration `0005_clinical_section_field_label.sql`): presentation-only label of a placement. NULL = the field's own label. It lets a tab show a shared global field under its SonoSoft name (Past Medical Hx shows `family_history` as "Family Medical Hx") without creating a second field. The seed sets or clears it from `labelOverrides` in `definitions.ts`.
- New field type `checkbox` (`clinical_field_definitions.field_type` is free text, so no schema change). Its entry value is `{ "optionIds": [], "freeText": "", "checked": true|false }`. `checked` is additive and optional in `ClinicalEntryValue`: it is always present on checkbox rows and never on any other field's rows, so every existing row and code path is unchanged.
- No new tables and no new triggers; `clinical_entries` stays append-only.
- New global fields are created by the seed (no migration): `past_medical_history`, `past_medical_unknown`, `prior_test_results`, `past_medical_additional_comments`, `surgical_history`, `impression`, `recommendations`, `stockings_type`, `stockings_compression`, `stockings_gender`, `stockings_color`, `stockings_measurements`, `assessment_additional_comments`; new sections `past_medical_hx` (sort 2) and `assessment_plan` (sort 3). Option lists start empty.
- Rollback of 0005: `ALTER TABLE clinical_section_fields DROP COLUMN label_override;` — drops only presentation labels (re-created by re-seeding after the column is re-added); no clinical data is touched. Take a backup first anyway. Entries written for the new fields are history and stay.

### Sprint 3B (deferred): Treatment Plan
Planned, NOT built: `treatment_plans` / `treatment_plan_items` (named above) with append-only item revisions, per-item versioning and audit, tombstone removal, an option list for the treatment/procedure, and no inventory or Procedure linkage. It requires an ADR and Product Owner answers first (ADR-027 "Deferred").

## R1a additions (ADR-028) — migration `0006_patient_v1_demographics.sql`

| Change | Notes |
|---|---|
| `demographic_options` (new) | `id`, `list_code` (CHECK: `nationality` \| `preferred_language`), `label`, `sort_order`, `is_active`, `created_by`, `created_at`. Unique on (`list_code`, `lower(label)`). Never renamed/deleted; retired via `is_active`. |
| `patients.nationality_option_id`, `patients.preferred_language_option_id` | uuid, nullable, FK → `demographic_options` (ON DELETE RESTRICT). |
| `patients.insurance_id` | text, nullable, NOT unique; index on `lower(insurance_id)`. |
| `patients.is_active` | boolean NOT NULL default true. |
| `patients.emergency_contact_name/phone/relationship` | text, nullable. |
| `patients.version` | integer NOT NULL default 1 — optimistic concurrency for demographic edits. |
| `patients_sex_check` | `sex IN ('F','M')` (NULL allowed), after normalising existing values (audited as `patient.sex_normalized`; aborts on unknown values). |
| `patient_external_ids` | unchanged; new system `NATIONAL_ID` alongside `ICARE_FILE_NO`. |

Rollback: see the header of the migration file. It drops the new constraint, indexes,
columns and table — which DESTROYS the new demographic data, so take a verified backup
first. Normalised sex values are not reverted automatically; the raw values are in the
`patient.sex_normalized` audit rows.

Audit actions added: `patient.deactivate`, `patient.reactivate`, `patient.sex_normalized`,
`demographic_option.create`, `demographic_option.update`.

## R1b additions (ADR-029)

- Migration `0007_clinical_section_field_group.sql`: `clinical_section_fields.group_label` (text, nullable) — presentation-only visual group of a placement, set by the seed. Rollback: `ALTER TABLE clinical_section_fields DROP COLUMN group_label;` (drops only headings; no clinical data touched).
- New field types (no DDL; `field_type` is text): `ordered_list` — value `{ "optionIds": [], "freeText": "", "rows": [{ "optionId": uuid|null, "freeText": "..." }], "display": "numbers"? }`; `number` — value `{ "optionIds": [], "freeText": "", "numberValue": 36.5 }`. Both additive/optional in `ClinicalEntryValue`; every existing row and code path is unchanged.
- New global fields (seed): `symptoms_worse_over_time`, `female_specific_statement`, `impression_rows` (list `impression`), `impression_init_venous_interp`, `recommendation_rows` (list `recommendations`), `stockings_mid_thigh`, `stockings_mid_calf`, `stockings_mid_ankle`, `stockings_floor_to_gf`, `stockings_floor_to_knee`.
- Retired by the seed (`is_active = false`, one-way): `progression`, `impression`, `recommendations`, `stockings_measurements`. Their entries are untouched and stay readable (read-only) on the visits that have them.
- Deploy: `npm run db:migrate`, then `npm run db:seed`.
