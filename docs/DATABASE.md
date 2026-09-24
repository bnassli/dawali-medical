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

## Clinical tables as implemented (Sprint 2)

| Table | Purpose / key columns |
|---|---|
| `clinical_sections` | `code` (unique), `name`, `sort_order`. Seeded from `src/modules/clinical/definitions.ts`. |
| `clinical_option_lists` | One list per select/multiselect field: `code` = `<section>.<field>` (unique). |
| `clinical_options` | `list_id`, `label`, `sort_order`, `is_active`, `created_by`. Unique on (`list_id`, `lower(label)`). Never renamed or deleted; retired via `is_active = false`. Starts EMPTY — values come from "+ Add New". |
| `clinical_field_definitions` | `section_id`, `code`, `label`, `field_type` (`select` \| `multiselect` \| `text` \| `textarea`), `option_list_id`, `allows_free_text`, `sort_order`, `is_active`. Unique on (`section_id`, `code`). Order follows `docs/CLINICAL_TABS.md`. |
| `clinical_entries` | Append-only revisions: `visit_id`, `field_definition_id`, `version`, `value` (jsonb `{ optionIds: uuid[], freeText: string }`), `client_mutation_id` (uuid, nullable), `created_by`, `created_at`. Unique on (`visit_id`, `field_definition_id`, `version`) and on `client_mutation_id` where not null. The current value is the highest `version`. |

Triggers (all enforced in the database, not only in code):
- `audit_logs_no_update_delete` — audit log is append-only (0001).
- `clinical_entries_no_update_delete` — clinical history is append-only (0003).
- `visits_reason_read_only` — the deprecated `visits.reason` column rejects any change (0005).

### Reason for Visit (ADR-024)
The only authoritative, writable source is `clinical_entries` for the field
`reason_for_visit`. `visits.reason` is a deprecated legacy column: backfilled by
migration 0005, read-only by trigger, never read or written by application code,
and to be dropped by a future migration after production validation
(`npm run db:verify-reason-backfill` must report `missing: 0`).

### Sprint 2 migrations
| File | Change | Rollback |
|---|---|---|
| `0002_clinical_foundation.sql` | Creates the five clinical tables. | Destructive `DROP TABLE`s — only on a database with no clinical data or after a verified backup. |
| `0003_clinical_entries_append_only.sql` | Append-only trigger on `clinical_entries`. | Drop trigger + function; no data touched. |
| `0004_clinical_concurrency.sql` | Adds `clinical_entries.client_mutation_id` + partial unique index. | Drop index and column (column holds only idempotency keys). |
| `0005_reason_for_visit_single_source.sql` | Ensures the Reason for Visit field rows, backfills `visits.reason`, verifies it, makes the column read-only. | Drop trigger + function; `visits.reason` was never modified. Backfilled entries/audit rows are history and stay. |

### Audit actions written by clinical code
`clinical_entry.create` (v1), `clinical_entry.update` (v2+, with before/after),
`clinical_entry.backfill`, `clinical_entry.backfill_skipped` (migration 0005),
`clinical_option.create`, `clinical_option.update` (retire/reactivate),
`access.denied` (with `visit_id`). Conflicts, replays and no-op saves write no
audit row because they change nothing.
