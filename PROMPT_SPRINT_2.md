# Prompt for Claude Code — Sprint 2

You are implementing Sprint 2 of the Dawali Medical System (Claude Code writes
all production code; Codex acts only as Technical Lead/reviewer).

Before writing code:
1. Read `CLAUDE.md`.
2. Read all `/docs`, especially CLINICAL_TABS, DATABASE, PERMISSIONS, TESTING, DECISIONS (ADR-018 to ADR-026), SPRINTS.
3. Inspect repository state.
4. Summarise requirement, affected files, DB impact, security/privacy impact, test plan, ambiguities before changing files.

> Provenance: this file was written after implementation, from the approved
> Sprint 2 requirements given in review (permissions, append-only saves, single
> source for Reason for Visit, optimistic concurrency, unload/navigation flush,
> Route Handlers, E2E) and the two read-only reviews that followed (length
> limit, navigation/Logout guard, visit isolation, denial audit, canonical
> origin, safe seeding, actor binding, mutation-id reuse, migration locking,
> retired fields, global fields). It records what was built; it is not a
> verbatim copy of an earlier prompt. Confirm it during review.

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
   clinical access whatsoever (cannot enter or read Reason for Visit). An admin who edits
   clinical data must also hold Doctor.
3. **Visit lock**: writes rejected (423) unless `visits.status = 'open'`.
4. **Reason for Visit** has exactly one authoritative writable source:
   `clinical_entries` field `reason_for_visit`.
   - Migration `0004` backfills every non-empty legacy `visits.reason`, verifies
     it, and makes the column read-only (DB trigger). It takes a
     `SHARE ROW EXCLUSIVE` lock on `visits` and `clinical_entries` first, never
     truncates (it ABORTS with a clear error if a trimmed legacy reason exceeds
     5000 characters), and audits `backfill_skipped` (raw text preserved) for
     EVERY visit that already had a reason entry, identical or not.
   - No application code reads or writes `visits.reason`; the column is dropped
     later, after production validation (`npm run db:verify-reason-backfill`).
   - Limit: 5000 characters (Unicode code points) in the schema, the HTML input
     and the service (defense in depth).
   - Entering it at visit creation requires `clinical.write` (UI hides the
     input otherwise; the server refuses with an audited 403). No exception for
     Reception.
5. **Concurrency**: every save carries `expectedVersion`; a stale save returns
   409 with the current value, writes no revision and no audit row.
   Last-write-wins is forbidden. UI shows Conflict with Keep mine / Use theirs.
6. **Idempotency**: every save carries `clientMutationId`; a replay (same visit,
   field, user, base version AND canonical value) returns the original result
   and writes nothing; any other reuse — including concurrent reuse across
   visits/users — is a deterministic 400, never a 500.
7. **No silent loss**: save on blur; flush pending edits on `pagehide`/`beforeunload`
   with `fetch(..., { keepalive: true })`; show a warning while anything is
   unsaved; hold unsent text only in memory (no localStorage/sessionStorage);
   a 401 keeps the text and offers Retry after signing in again. In-app link and
   form navigation (including Logout) is intercepted while any field is
   unsaved/in flight/failed/conflicted/locked: flush first, and require an
   explicit "discard" confirmation if anything is still not stored.
8. **Route Handlers**: autosave goes through same-origin, body-size-bounded,
   authenticated `POST /api/visits/{visitId}/clinical-entries/{fieldId}`,
   `POST /api/clinical/fields/{fieldId}/options` (+ Add New) and
   `GET /api/visits/{visitId}/clinical-sections/{sectionCode}` (fresh state).
   Status mapping: 401 unauthenticated, 400 invalid, 403
   forbidden/cross-origin/actor-mismatch, 404 unknown, 409 conflict, 413 too
   large, 415 not JSON, 423 visit locked. `patientId` is derived from the visit
   and never accepted from the client. Origin is compared with the canonical
   `APP_ORIGIN` (scheme + host + port); forwarded headers are never trusted;
   production fails closed without it. Access-denied audit is safe for
   nonexistent/malformed ids (403, not 500; attempted ids in metadata).
9. **Actor binding**: requests carry the id of the user the page was rendered
   for; if the session now belongs to someone else the request is refused and the
   text stays unsaved — never attributed to the other user.
10. **Visit isolation**: savers, visit id and fields are per (visit, user) and
    keyed so V1 -> V2 -> V1 or a refresh cannot reuse them; back/forward
    restores are reconciled with the server's current state.
11. **Global fields (ADR-026)**: field definitions are global (unique code) and
    separate from section placement; option lists are reusable; the seed never
    silently changes a field's type/option list (a migration is required);
    retired fields with history stay visible, read-only.

## Tests required
- Vitest integration (real PostgreSQL): save/load, append-only + trigger, audit,
  permissions per role, visit lock, option validation, concurrency, idempotency
  and reuse, Route Handler status mapping and origin rules, actor binding,
  denial audit for nonexistent ids, Reason-for-Visit backfill/verification/
  limit/lock/read-only/static guard, definitions (global fields, placement,
  shared lists, seed drift, retired fields), client autosave engine, navigation
  guard decisions.
- Playwright E2E (production build + real PostgreSQL in CI): exact field order,
  selection persistence, permanent vs visit-only options, keyboard operation,
  concurrent conflict, pending text + session expiry, reload/navigation flush,
  navigation/Logout guard (expired, offline, conflict, locked, discard), actor
  change, visit switching, intake reason length, retired fields, role differences.

Before completion: typecheck, lint, tests, build, E2E, `db:validate`. Report
changed files, migrations, tests, known limitations. Do not open the PR or merge
without explicit instruction.
