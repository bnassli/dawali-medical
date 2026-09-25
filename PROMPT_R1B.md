# Prompt for Claude Code — R1b: Clinical UI reconciliation against SonoSoft screens

You are implementing phase R1b of the Dawali Medical System (see `docs/SPRINTS.md`).
Work on a new branch. Do not merge without explicit instruction.

> Provenance: written 2026-09-25 from a screen-by-screen review of the legacy SonoSoft
> app against this repository (review doc kept by the Product Owner; item codes such as
> S1 or AP5 refer to it). Redacted reference screenshots are in
> `docs/reference/sonosoft/`. **Items marked "needs PO confirmation" contradict
> `docs/FINAL_V1_REQUIREMENTS_RECONCILIATION.md` §6.2. Do not build them until the
> Product Owner confirms in writing; build everything else.**

## Before writing code
1. Read `CLAUDE.md`, `docs/CLINICAL_TABS.md`, `docs/DECISIONS.md` (ADR-018 to ADR-028),
   `docs/DATABASE.md`, `docs/TESTING.md`, `docs/FINAL_V1_REQUIREMENTS_RECONCILIATION.md`
   §6.1 to §6.3, and `docs/reference/sonosoft/README.md`.
2. Open these screenshots and treat them as the layout reference:
   - `docs/reference/sonosoft/tabs/workup-01-subj-complaints-habits.jpg`
   - `docs/reference/sonosoft/tabs/workup-03-past-medical-hx.jpg`
   - `docs/reference/sonosoft/tabs/workup-09-assessment-plan-plus.jpg`
3. Summarise requirement, affected files, DB impact, security/privacy impact, test plan
   and ambiguities before changing files (CLAUDE.md).

## Product Owner decision that governs all UI in this phase (2026-09-25)
Each tab must look like its SonoSoft screenshot: same boxes (bordered groups), same field
positions relative to each other, same labels word for word (including SonoSoft's own
spelling, e.g. "Recomendations"), same buttons. Doctors must not have to relearn the
screen. Allowed differences: clearer font and colours, no fixed empty rows, no buttons
that are out of scope (Add Charge, Registry Data). The grey legacy row under the patient
header (Home, Ext Demographics, Contact Info, Insurance...) is **not** shown.

This phase changes presentation and adds fields. It must not change autosave, the
unsaved-navigation guard, append-only history, audit, optimistic concurrency,
idempotency, the visit lock, origin/actor binding, or permissions.

## Part A — Subj Complaints Habits

A1. **Layout and labels.** Rebuild the tab as the five SonoSoft boxes, in this order:
   1. Chief complaints box: "Add Chief Complaints with characteristics and Associated
      conditions" button; complaint field with "associated with" beside it; How long?;
      Symptoms getting worse over time?; Affects daily living activities?;
      Chest comments; Comment.
   2. Red-bordered box: Aggravating Factors | Relieving Factors, side by side.
   3. Blue-bordered box: Previous conservative therapy; How long?; Family history of VV?
   4. Habits box: Alcohol; Exercise; Tobacco use.
   5. Medications box: Pain Meds for CC; Current Meds (+ None); Allergies (+ No known).
   Reason for visit and Problem List sit above the boxes. Relabel fields to the exact
   SonoSoft labels (labels are cosmetic; the seed may update them, ADR-026).

A2. **S3 — Symptoms getting worse over time?** SonoSoft has a checkbox followed by a
   dropdown. Add a checkbox field `symptoms_worse` placed immediately before the existing
   `progression` select; relabel `progression` so the pair reads like SonoSoft. No
   exclusion rule.

A3. **S5 / S6 — None and No known.** Add checkbox fields `current_meds_none` (label
   "None") and `allergies_no_known` (label "No known"). Add exclusion rules
   (`FIELD_EXCLUSION_RULES`, ADR-027 mechanism, enforced inside the visit lock):
   `current_meds_none` excludes `current_meds`; `allergies_no_known` excludes `allergies`.
   The UI disables the counterpart with an explanation and never clears it.

A4. **S1 — Family history of VV? (needs PO confirmation).** In SonoSoft this is a
   separate single-choice question about varicose veins (answer on the reference patient:
   "not sure") and is a different field from Past Medical Hx "Family Medical Hx" (same
   patient: "mother.sister"). §6.2 of the requirements says to keep one shared source.
   If confirmed: add a global select field `family_history_vv` (own option list, visit-only
   free text allowed) and place it in Subj where `family_history` is today; remove the
   `family_history` placement from Subj with an additive migration (the seed never removes
   placements, ADR-026); `family_history` stays in Past Medical Hx. Existing
   `family_history` entries stay where they are (history is never rewritten) and remain
   visible in Past Medical Hx. Record the decision as a new ADR.

A5. Out of scope in Subj: pairing each chief complaint with its associated condition as
   repeatable rows (S2), the None checkbox next to Reason for visit (S4, meaning unknown),
   Reconciliation performed / Reconcile (S7), Recode / Snomed (S11). List them as known
   limitations.

## Part B — Past Medical Hx

B1. **Layout.** "Click to Add" column of buttons on the left (Past Medical Hx, Family
   Medical Hx with Unknown under it, Prior Test Results), each with its large text area to
   the right; Additional Comments; a blue-bordered box holding Surgical Hx and the female
   statement. Selected options appear as editable text in the large area, as in SonoSoft
   (P4): same data model (options + visit-only free text), paragraph-style display.

B2. **P2 — Female statement.** Add select field `female_statement`, label
   "If FEMALE select the appropriate statement; otherwise disregard", own option list,
   placed last in the tab inside the Surgical Hx box. §6.2 says it is visible/enabled only
   when the patient's sex is Female; SonoSoft always shows it. Resolve both: always render
   it in its SonoSoft position, enabled only when `patients.sex = 'F'`, disabled with the
   reason otherwise. The server must reject a value when the patient is not female (403 or
   400, audited like other refusals; decide and document). Report use (RP13, R5): the
   statement goes into the opening sentence for female patients only.

B3. **P3 — Additional Comments.** SonoSoft shows a dropdown with free text, not a plain
   text area. The entry value shape is the same (`{ optionIds, freeText }`), so prefer an
   additive migration that changes `past_medical_additional_comments` to a select with its
   own empty option list; if you find a reason that is unsafe, retire the field and add a
   replacement instead (ADR-026). Document the choice.

B4. **P1 — Unknown belongs to Family Medical Hx (needs PO confirmation; depends on A4).**
   In SonoSoft the Unknown checkbox sits under Family Medical Hx (family history unknown).
   Today `past_medical_unknown` excludes `past_medical_history`. If confirmed: retire
   `past_medical_unknown` (it stays visible read-only where it has history) and add a
   checkbox `family_history_unknown` placed under Family Medical Hx, excluding
   `family_history`. Do this only after A4, otherwise the rule would also block the Subj
   question.

## Part C — Assessment Plan+

C1. **AP1 / AP2 — ordered rows.** Impression: 8 visible rows in two columns (1–4, 5–8),
   red row numbers, a "Select Impressions" button that fills the next empty row.
   Recommendations: 8 rows in one column, "Select Recomendations" button (SonoSoft
   spelling). Recommended model: 8 global select fields per list
   (`impression_1` … `impression_8`, `recommendation_1` … `recommendation_8`), all sharing
   one option list (`impression` / `recommendations`), each with visit-only free text.
   Each row then keeps its own version stream, audit and concurrency with no new value
   shape. Retire `impression` and `recommendations`; their existing history stays visible
   read-only (ADR-026). If you choose another model, justify it in the ADR. The Post EVLT
   screen will have its own impression rows (4) later; do not share these fields with it.

C2. **AP3 — Impr for Init Venous Interp.** Add select field
   `impr_for_init_venous_interp` (own option list, free text allowed), full width under
   the impression rows.

C3. **AP4 — Bullets / Numbers.** A per-visit display choice for the report's lists. It is
   presentation, not a clinical dropdown, so its two values may be fixed in code; add the
   smallest additive field type that fits (e.g. a two-choice radio) and document why
   CLAUDE.md rule 10 does not apply.

C4. **AP5 — Stocking measurements.** Add five numeric fields in the SonoSoft order:
   `stockings_mid_thigh`, `stockings_mid_calf`, `stockings_mid_ankle` (group "SIZE") and
   `stockings_floor_to_gf`, `stockings_floor_to_knee` (group "DISTANCE"). One set per
   visit, as on the SonoSoft screen. Unit: centimetres (default; the PO has an open
   question on unit and per-leg sets, so keep the unit in one constant). This needs a
   numeric field type: add it additively (value stored as a decimal with range validation,
   e.g. 0–200, one decimal) and document it. Retire `stockings_measurements`; it stays
   visible read-only where it has history.

C5. Layout: Impression box, Recommendations box, Stockings detail box with Type /
   Compression on the first line, Gender / Color on the second, and the SIZE / DISTANCE
   group on the right; Tutorial button top right.

C6. Out of scope: the "send recommendation to Treatment Plan" action (AP7, needs R2) and
   Additional Comments visibility (AP6, open question: keep the current field as is).

## Part D — Patient Search (follow-up to R1a)

Reference: SonoSoft's search window (no screenshot in the repo; described here).
D1. **PS1 — search as you type.** Results filter while typing (debounced, about 300 ms),
    with no Search button needed. Before anything is typed, show the most recently
    created or updated patients (limit as today). Criteria still travel by POST, never in
    the URL (ADR-028).
D2. **PS2 — layout.** Results table on top, criteria fields below it, and the line
    "Double click on the patient you would like to select." above the table. Columns:
    MedicalID, Last Name, First Name, Birthdate. Keep keyboard access (Enter opens).
D3. **PS3 — Birthdate.** A text field in day/month/year with the hint "E.G. 01/01/1925",
    parsed strictly; reject impossible dates with a clear message.
D4. **PS4.** Next to "Create a New Patient Record" show: "If the patient does not exist,
    then you can create a new patient here. The data will be transferred to the Patient
    Demographic form." Add a Close button in the modal.

## DB impact (expected)
- Additive migrations only: new field types (numeric, two-choice), placement removal for
  A4 if confirmed, field type change for B3 if chosen. Every migration idempotent, with a
  rollback note in `docs/DATABASE.md`. No clinical entry is ever deleted or rewritten.
- New fields, option lists and placements come from the seed. Existing databases run
  `npm run db:migrate` then `npm run db:seed`.

## Tests required
- Vitest (real PostgreSQL): new fields save/version/audit like existing ones; exclusion
  rules for A3 (and B4 if confirmed) under concurrency; `female_statement` refused for a
  non-female patient; numeric validation (range, decimals, empty); retired fields stay
  readable and refuse writes; seed idempotency with the new definitions.
- Playwright: each tab renders its boxes in SonoSoft order with the exact labels;
  disabled counterparts show their reason; Impression rows fill in order via
  "Select Impressions"; search-as-you-type opens a patient by double-click and Enter.
- Update `docs/TESTING.md` with an "R1b additions" list.

## Before completion
Typecheck, lint, tests, build, `db:validate`, focused E2E. Report changed files,
migrations, tests, known limitations and every item left for PO confirmation.
