# Delivery Plan

## Completed
Sprint 1: foundation, env, DB/migrations, auth, users/roles foundation, patients, visits, patient search, Patient Chart shell, audit foundation.
Sprint 2: dynamic option lists, +Add, free text, auto-save, audit, Subj Complaints Habits.
Sprint 3A: Past Medical Hx, Assessment Plan+ (data-driven clinical tabs; ADR-027; PROMPT_SPRINT_3A.md).
R1a: Persistent Patient Header, Patient Search, V1 Create/Edit Patient, Inactive patients (ADR-028).
R1b: Clinical tabs and Patient Search matched to the SonoSoft screens (ADR-029; PROMPT_R1B.md).

## V1 reconciliation (current plan)
Source: `docs/FINAL_V1_REQUIREMENTS_RECONCILIATION.md` §15. It supersedes the former
Sprint 3B–7 plan (Treatment Plan, Follow Up/Laser, diagrams, reports, iCare), whose scope
is carried into the phases below. One phase at a time, each on its own branch/PR.

R1a: Persistent Patient Header, Patient Search, V1 Create/Edit Patient, Inactive patients (ADR-028).
R1b: Clinical UI reconciliation — Past Medical Hx female-specific statement; Assessment Plan+ ordered Impression/Recommendation rows, Impr for Init Venous Interp, structured stockings measurements; Subj Complaints Habits relabelling, checkbox correction and grouping.
R2: Treatment Plan (repeatable ordered rows; additive migration; no Inventory).
R3: Follow Up Office Visit, Laser Ablation, Comprehensive / General Clinical Exam.
R4: Diagram engine (Create Leg Diagram / Create Vein Diagram, versioned, no overwrite).
R5: Report engine (Template 1 and 2, editable DOCX, lifecycle, patient file indexing).
R6: iCare integration (manual external identifier, then connector/sync), staging validation, deployment hardening.

Future: Inventory + invoice OCR/AI + batch/expiry + procedure consumption.
