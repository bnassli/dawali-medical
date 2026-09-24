# Prompt for Claude Code — Sprint 2

You are implementing Sprint 2 of the Dawali Medical System (Claude Code writes
all production code; Codex acts only as Technical Lead/reviewer).

Before writing code:
1. Read `CLAUDE.md`.
2. Read all `/docs`, especially CLINICAL_TABS, DATABASE, PERMISSIONS, TESTING, DECISIONS (ADR-018 to ADR-025), SPRINTS.
3. Inspect repository state.
4. Summarise requirement, affected files, DB impact, security/privacy impact, test plan, ambiguities before changing files.

> Provenance: this file was written after implementation, from the approved
> Sprint 2 requirements given in review (permissions, append-only saves, single
> source for Reason for Visit, optimistic concurrency, unload flush, Route
> Handler, E2E). It records what was built; it is not a verbatim copy of an
> earlier prompt. Confirm it during review.

## Implement only (Sprint 2 = SPRINTS.md line 3)
- dynamic option lists (`clinical_option_lists`, `clinical_options`), never hard-coded
- `+ Add New`: permanent option, or visit-only free text
- auto-save with audit
- Subj Complaints Habits tab, fields in `docs/CLINICAL_TABS.md` order
- admin retire/reactivate of options

## Explicitly out of scope
Past Medical Hx, Assessment Plan+, Treatment Plan, Follow Up, Laser Ablation,
diagrams, reports, iCare, inventory, visit close/finalize. Do not start Sprint 3.

## Approved requirements
1. **Storage**: clinical values are append-only version rows in
   `clinical_entries` (DB trigger rejects UPDATE/DELETE). Every create/update is
   audited in the same transaction. A no-op save writes nothing.
2. **Permissions** (exact): Admin = `clinical.read`, `clinical_option.add`,
   `clinical_option.manage`, NOT `clinical.write`. Doctor = `clinical.read`,
   `clinical.write`, `clinical_option.add`. Nurse/Assistant = `clinical.read`,
   `clinical.write` (visit-only free text, no permanent options). Reception = no
   clinical access. An admin who edits clinical data must also hold Doctor.
3. **Visit lock**: writes rejected (423) unless `visits.status = 'open'`.
4. **Reason for Visit** has exactly one authoritative writable source:
   `clinical_entries` field `reason_for_visit`. Migration 0005 backfills every
   non-empty legacy `visits.reason`, verifies it, and makes the column read-only
   (DB trigger). No application code reads or writes `visits.reason`; the column
   is dropped later, after production validation (`npm run db:verify-reason-backfill`).
5. **Concurrency**: every save carries `expectedVersion`; a stale save returns
   409 with the current value, writes no revision and no audit row.
   Last-write-wins is forbidden. UI shows Conflict with Keep mine / Use theirs.
6. **Idempotency**: every save carries `clientMutationId`; a replay returns the
   original result and writes nothing; reuse for a different field/user is 400.
7. **No silent loss**: save on blur; flush pending edits on `pagehide`/`beforeunload`
   with `fetch(..., { keepalive: true })`; show a warning while anything is
   unsaved; hold unsent text only in memory (no localStorage/sessionStorage);
   a 401 keeps the text and offers Retry after signing in again.
8. **Route Handler**: autosave goes through a same-origin, body-size-bounded,
   authenticated `POST /api/visits/{visitId}/clinical-entries/{fieldId}`
   (and `POST /api/clinical/fields/{fieldId}/options` for + Add New). Status
   mapping: 401 unauthenticated, 400 invalid, 403 forbidden/cross-origin,
   404 unknown, 409 conflict, 413 too large, 415 not JSON, 423 visit locked.
   `patientId` is derived from the visit and never accepted from the client.

## Tests required
- Vitest integration: save/load, append-only + trigger, audit, permissions per role,
  visit lock, option validation, concurrency, idempotency, Route Handler status
  mapping, Reason-for-Visit backfill/verification/read-only/static guard,
  client autosave engine.
- Playwright E2E (production build + real PostgreSQL in CI): exact field order,
  selection persistence, permanent vs visit-only options, keyboard operation,
  concurrent conflict, pending text + session expiry, reload/navigation flush,
  Reason for Visit single source, role differences.

Before completion: typecheck, lint, tests, build, E2E, `db:validate`. Report
changed files, migrations, tests, known limitations. Do not open the PR or merge
without explicit instruction.
