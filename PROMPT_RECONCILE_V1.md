# Prompt — Reconcile Dawali Medical with Final V1 Requirements

You are working on the existing Dawali Medical repository.

## Mandatory references
Read first:
1. `CLAUDE.md`
2. `docs/FINAL_V1_REQUIREMENTS_RECONCILIATION.md`
3. Relevant current `/docs`
4. Current implementation and tests

The new final reconciliation document is the Product Owner's reviewed requirement source. If an older requirement conflicts with it, **do not guess**: follow the new reviewed requirement and record the conflict in the implementation plan/ADR where needed.

## Important
The project already has a strong backend foundation. Do **not** restart or rewrite it.

Already merged foundations include:
- auth/sessions,
- RBAC,
- patients/visits,
- audit,
- dynamic clinical options,
- autosave/concurrency/idempotency,
- Subj Complaints Habits,
- Past Medical Hx,
- Assessment Plan+,
- CI/tests/migrations.

## Your task
First perform a read-only reconciliation review.

Produce:
1. What currently matches the final requirements.
2. What is missing.
3. What is implemented differently and must be corrected.
4. DB/data-model changes required.
5. UI-only changes required.
6. Security/privacy implications.
7. A proposed branch-by-branch plan matching R1–R6.

Do **not** write production code during this first review.

## After review approval
Implement only the approved phase, starting with **R1 — Clinical UI reconciliation**.

Rules:
- Work on a new branch; never directly on `main`.
- Do not auto-merge.
- Preserve history/audit/permissions/concurrency/autosave.
- Add migrations only when necessary; never rewrite merged migration history.
- Never commit PHI, real patient screenshots, backups, secrets or `.env`.
- Add focused tests for corrected requirements.
- Run typecheck, lint, tests, E2E as appropriate, build and DB validation.
- Stop after the approved phase and report results.
- Do not proceed to the next phase without explicit approval.

## R1 priorities
1. Persistent SonoSoft-familiar Patient Header without the unwanted legacy navigation row.
2. Patient Search modal/table with Insurance ID search.
3. Simplified V1 Create/Edit Patient form.
4. Past Medical Hx female-specific statement field.
5. Assessment Plan+ reconciliation:
   - ordered Impression rows,
   - ordered Recommendation rows,
   - structured stockings measurements.

Do not start Treatment Plan, Follow Up, Laser, Comprehensive Exam, diagrams, reports or iCare until R1 is reviewed and approved.
