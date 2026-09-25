# R2 — Treatment Plan (design and build brief)

Phase R2 of `docs/SPRINTS.md`. Reference screen:
`docs/reference/sonosoft/tabs/treatment-01-treatment-plan.jpg`.
Requirements: `docs/FINAL_V1_REQUIREMENTS_RECONCILIATION.md` §6.4, ADR-027 "Deferred".

## Product Owner decisions (2026-09-25)
1. **One plan per patient.** The table keeps growing across visits (the SonoSoft
   screen shows rows from 2022 to 2026). Every visit of the patient shows the same plan.
2. **Who edits:** Doctor and Nurse/Assistant (`clinical.write`); Admin reads only;
   Reception has no access (`clinical.read` required). Same as the other clinical tabs.
3. **Order and removal:** rows keep the order they were added in (no drag reordering).
   A wrong row is never deleted: it is marked **Cancelled** and stays in the history.

## Screen (SonoSoft layout, same rules as ADR-029)
Four columns, one row per treatment/procedure, drawn at SonoSoft's pixel positions:
Scheduled (date) | Completed (date) | Recommended Treatment/Procedures in the order to be
received (combo box: list + free text + "+ Add New") | Approval/Status/Comments (combo
box: list + free text + "+ Add New"). Dates are typed day/month/year as in SonoSoft.
A small "Cancelled" tick box closes each row (not in SonoSoft; PO decision 3).
Existing rows first, in order, then empty rows up to SonoSoft's 25 (at least 5 empty).
Typing in an empty row creates the row. Everything autosaves like the other tabs.

## Data model (additive migration 0008)
- The four columns and Cancelled are ordinary global field definitions
  (`treatment_scheduled`, `treatment_completed`, `treatment_procedure`,
  `treatment_status`, `treatment_cancelled`), so option lists, "+ Add New", retire,
  labels and value validation are the existing clinical machinery. They are placed in
  no tab. New field type `date` (ISO `YYYY-MM-DD` in `freeText`).
- `treatment_plan_items`: one row per plan line — `id`, `patient_id`, `position`
  (unique per patient, assigned max+1 under the patient row lock), `created_in_visit_id`,
  `created_by`, `created_at`. Insert-only (trigger).
- `treatment_plan_entries`: append-only versions of one cell — `item_id`,
  `field_definition_id`, `version`, `value` (same shape as clinical entries), `visit_id`
  (the visit the change was made from), `client_mutation_id` (idempotency), `created_by`,
  `created_at`. Unique (item, field, version). Update/Delete rejected by trigger.
- The client names a new row's id (UUID) itself; the first non-empty save of a cell
  creates the item. An id that belongs to another patient is refused as not found.
- Section `treatment_plan` (sort 4) is the tab; it has no placed fields.

## Rules kept from the clinical tabs
Optimistic concurrency per cell (409 + Keep mine / Use theirs), clientMutationId replay,
visit must be open (423 otherwise), expectedUserId actor binding, same-origin checks,
audit on every create/update (`treatment_plan_item.create`,
`treatment_plan_entry.create/update`, with patient and visit ids), unsaved-navigation
guard, no browser storage. No inventory linkage (future, nullable, no workflow change).

## Tests
Vitest (real PostgreSQL): row creation on first save and ordering, same plan from
another visit of the patient and not from another patient, per-cell history and
conflict, replay/reuse of mutation ids, closed visit, date validation, cancel keeps the
row, permissions per role, audit rows, append-only triggers, migration idempotency.
Playwright: layout order, typing a row and reloading, the plan seen from a second
visit, "+ Add New" on procedure, cancelling, nurse/admin/reception access.

## Out of scope
Drag reordering, printing, report binding (R5), inventory (future), the Treatment /
Workup tab-set switch (the tab is added after Assessment Plan+).
