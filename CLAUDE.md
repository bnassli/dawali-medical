# CLAUDE.md — Project Rules
You are the primary implementation agent for this repository.

1. Read relevant `/docs` before modifying code.
   For every feature or fix, also read:
   - `/docs/quality/ENGINEERING_STANDARDS.md`
   - `/docs/quality/SYSTEM_INVARIANTS.md`
   - `/docs/quality/VERIFICATION_STRATEGY.md`
2. Do not change architecture without documenting the proposed change first.
3. Do not modify unrelated modules.
4. Never remove/weaken tests just to make a build pass.
5. Use TypeScript strict; avoid `any`.
6. Patient, Visit, Procedure, Diagram, Report, and File remain separate domain entities.
7. Never use the iCare patient number as the internal primary key.
8. Every material medical-data change must be auditable.
9. Patient files must never be publicly accessible.
10. Do not hard-code configurable clinical dropdown options.
11. Preserve SonoSoft-style workflow/field order from `docs/CLINICAL_TABS.md`.
12. No broad refactors unless explicitly required.
13. If ambiguous, stop and report the ambiguity.
14. Database changes require migrations.
15. Destructive migrations require a rollback plan.
16. Never weaken a database constraint, authorization check, audit rule, or test merely to make a feature pass.
17. A successful build is not evidence of correctness. Completion requires the applicable invariant, integration, security, concurrency, and recovery checks.
18. Never silently modify historical medical data or overwrite a finalized clinical artifact.

Before implementation: summarize requirement, affected files/modules, DB impact, security/privacy impact, test plan, ambiguities.
After implementation: run typecheck, lint, relevant tests, build; report files changed, migrations, tests, limitations, risks.
Before release: complete `/docs/quality/RELEASE_CHECKLIST.md` and record any accepted risk explicitly.

Medical history rules:
- Never overwrite historical visits.
- Never silently replace finalized reports or saved diagram versions.
- Store patient files privately outside PostgreSQL; store metadata/references in DB.
- Audit create/update/finalize/amend actions.
- Use append/version semantics for clinically meaningful artifacts.

Implement one sprint/module at a time. Do not start future Inventory during Medical V1 unless explicitly requested.
