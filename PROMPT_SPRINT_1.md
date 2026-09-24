# Prompt for Claude Code — Sprint 1

You are implementing Sprint 1 of the Dawali Medical System.

Before writing code:
1. Read `CLAUDE.md`.
2. Read all `/docs`, especially PRODUCT_SPEC, ARCHITECTURE, DATABASE, PERMISSIONS, TESTING, DECISIONS, SPRINTS.
3. Inspect repository state.
4. Produce a concise implementation plan before changing files.

## Implement only
- project foundation
- environment configuration
- PostgreSQL integration
- migration foundation
- authentication
- users
- roles/permissions foundation
- patients
- visits
- patient search
- create/open patient
- create/open visit
- patient chart shell
- audit-log foundation
- logout

## Explicitly out of scope
Do not implement clinical tabs, diagrams, reports, iCare integration, inventory, or invoice AI/OCR.

## UX
Patient Chart shell should support future SonoSoft-like layout:
- demographics/header on top
- tab area placeholder
- content area
- action area
Do not prematurely design clinical tabs.

## Technical
- TypeScript strict
- modular monolith
- internal UUID for Patient
- external file number is attribute, not PK
- Visit separate from Patient
- migrations required
- auditable Patient/Visit changes
- no public patient files
- no secrets in source control

## Focused tests
- auth protection
- patient creation
- patient search
- visit creation
- patient/visit relationship
- permission denial
- audit record on patient/visit change

Before completion: typecheck, lint, tests, production build.
Then report changed files, migrations, tests, known limitations.
Do not start Sprint 2.
