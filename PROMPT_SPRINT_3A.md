# Prompt for Claude Code — Sprint 3A

You are implementing Sprint 3A of the Dawali Medical System (Claude Code writes all
production code; reviews are read-only). Work in the current worktree only.

Before writing code:
1. Read `CLAUDE.md`.
2. Read the relevant `/docs`: CLINICAL_TABS, DATABASE, PERMISSIONS, TESTING, DECISIONS
   (ADR-018 to ADR-027), SPRINTS.
3. Inspect repository state.
4. Summarise requirement, affected files, DB impact, security/privacy impact, test plan,
   ambiguities before changing files.

> Provenance: written after implementation from the Product Owner's approval of the
> recommended Sprint 3A defaults following the second Technical Lead review (which
> found Sprint 3 = Past Medical Hx, Assessment Plan+ and Treatment Plan too ambiguous to
> build as one unit). It records what was built; confirm it during review.

## Implement only (Sprint 3A = SPRINTS.md)
- Past Medical Hx tab and Assessment Plan+ tab, fields in `docs/CLINICAL_TABS.md` order.
- Data-driven tab navigation; exactly one section form rendered; unsaved-navigation
  protection retained.
- Explicit `fieldCodes` per section (Subj unchanged).

## Explicitly out of scope
- **Treatment Plan (deferred Sprint 3B)**, Follow Up, Laser Ablation, diagrams, reports,
  iCare, inventory, visit close/finalize.
- The female-specific Past Medical Hx field and any conditional visibility (no SonoSoft
  reference supplied).
- Structured stocking measurements, prescription carry-forward, report bindings.
- Do not open a PR or merge without explicit instruction.

## Approved decisions
1. Family Medical Hx **is** the existing global `family_history` (one source of truth);
   shown as "Family Medical Hx" via a presentation-only placement label.
2. Impression and Recommendations: dynamic reusable options (start empty, "+ Add New")
   plus visit-only free text.
3. Stockings: independent per-visit fields — type, compression, gender (cut), color as
   single-selects with dynamic option lists; measurements as free text. No top-level
   yes/no, no auto-population from demographics.
4. Unknown means the past medical history is unknown and must not coexist with Past
   Medical Hx values: additive `checkbox` field type + `checked` value flag, server-side
   exclusion inside the visit lock, UI disables (never clears) the counterpart.
5. No new permissions; existing security/audit/append-only/concurrency/idempotency/visit
   lock/origin/actor rules apply unchanged.

## Durable field codes (ADR-027)
| Tab (section code) | Order | Code | Type |
|---|---|---|---|
| Past Medical Hx (`past_medical_hx`) | 1 | `past_medical_history` | multiselect |
| | 2 | `family_history` (existing, shared; label "Family Medical Hx") | multiselect |
| | 3 | `past_medical_unknown` | checkbox |
| | 4 | `prior_test_results` | textarea |
| | 5 | `past_medical_additional_comments` | textarea |
| | 6 | `surgical_history` | multiselect |
| | (7) | female-specific field | **deferred** |
| Assessment Plan+ (`assessment_plan`) | 1 | `impression` | multiselect |
| | 2 | `recommendations` | multiselect |
| | 3 | `stockings_type` | select |
| | 4 | `stockings_compression` | select |
| | 5 | `stockings_gender` | select |
| | 6 | `stockings_color` | select |
| | 7 | `stockings_measurements` | textarea |
| | 8 | `assessment_additional_comments` | textarea |

Subj Complaints Habits (`subj_complaints_habits`) is unchanged: its 20 fields are now an
explicit list.

## DB
Migration `0005_clinical_section_field_label.sql`: nullable `clinical_section_fields.label_override`.
Rollback and details in `docs/DATABASE.md`. New fields/sections come from the seed:
run `npm run db:migrate` then `npm run db:seed`.

## Tests required
Vitest (real PostgreSQL) and Playwright as listed in `docs/TESTING.md` "Sprint 3A additions".

Before completion: typecheck, lint, tests, build, `db:validate`, focused E2E. Report changed
files, migrations, tests, known limitations.
