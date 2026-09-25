# Clinical Tabs — Medical V1

Global rule: preserve SonoSoft-style order and familiarity. Applicable fields support predefined options, `+ Add New`, reusable save, and visit-only free text.

Visual reference: redacted SonoSoft screenshots of each tab and of the reports are in `docs/reference/sonosoft/` (see its README). Where a screenshot exists, the tab's layout, grouping and labels follow it.

## Subj Complaints Habits
Reason for visit; Problem List; Chief Complaints; characteristics; duration; progression; daily-activity impact; chest comments; comments; aggravating factors; relieving factors; previous conservative therapy + duration; family history; alcohol/exercise/tobacco; pain meds; current meds; allergies.

Implemented (R1b, ADR-029), SonoSoft labels and boxes (`workup-01-subj-complaints-habits.jpg`):
Reason for visit, Problem List | box "Add Chief Complaints with characteristics and Associated conditions": Chief Complaints, associated with, How long?, Symptoms getting worse over time? (checkbox), Progression, Affects daily living activities?, Chest comments, Comment | red box: Aggravating Factors, Relieving Factors | blue box: Previous conservative therapy, How long?, Family history of VV? | Habits: Alcohol, Exercise, Tobacco use | Pain Meds for CC, Current Meds + None, Allergies + No known.
None / No known exclude Current Meds / Allergies. The general family history is no longer on this tab (S1): it is "Family Medical Hx" in Past Medical Hx.

## Past Medical Hx
Past Medical Hx; Family Medical Hx; Unknown; Prior Test Results; Additional Comments; Surgical Hx; female-specific option/field from reference screen.

Implemented (Sprint 3A, ADR-027; reconciled by R1b, ADR-029), in this order:
1. Past Medical Hx — multiselect, dynamic options + visit-only free text (`past_medical_history`).
2. Family Medical Hx — the global `family_history`, shown under the SonoSoft label.
3. Unknown — checkbox under Family Medical Hx (`family_history_unknown`); excludes Family Medical Hx (server-enforced, the UI mirrors it). The Sprint 3A `past_medical_unknown` is retired (history read-only).
4. Prior Test Results — textarea (`prior_test_results`).
5. Additional Comments — dropdown + free text (`past_medical_additional_comments`, own list, distinct from the Assessment one).
6. Surgical Hx — multiselect + free text (`surgical_history`), in the blue box.
7. If FEMALE select the appropriate statement; otherwise disregard — select (`female_statement`), usable only when the patient's sex is F (disabled otherwise; server-enforced).

## Assessment Plan+
Order: Impression → Recommendations → Stockings detail → Additional Comments.
Stockings structured: type, compression, gender, color, measurements.

Implemented (R1b, ADR-029; `workup-09-assessment-plan-plus.jpg`): Impression box — Bullets / Numbers (`impression_list_style`), rows 1–8 (`impression_1..8`, one shared "impression" list, shown 1–4 | 5–8), "Select Impressions" fills the next empty row, Impr for Init Venous Interp (`impr_for_init_venous_interp`) -> Recommendations box — rows 1–8 (`recommendation_1..8`, shared "recommendations" list), "Select Recomendations" -> Stockings detail — Type, Compression, Gender, Color (single selects, own lists) and SIZE Mid Thigh / Mid Calf / Mid Ankle, DISTANCE Floor To GF / Floor To Knee (numbers, cm, 0–200, one decimal) -> Additional Comments (`assessment_additional_comments`). Retired from Sprint 3A: `impression`, `recommendations`, `stockings_measurements` (history read-only). "Gender" is the stocking cut, not the patient's sex.

## Treatment Plan
Scheduled | Completed | Recommended Treatment/Procedures in order | Approval/Status/Comments.
Future inventory linkage must not change doctor workflow.

Implemented (R2, ADR-030; `treatment-01-treatment-plan.jpg`): one plan per patient, shown
identically in every visit. Columns Scheduled and Completed (dates, typed day/month/year),
Recommended Treatment/Procedures in the order to be received and Approval/Status/Comments
(combo boxes: own list + free text + "+ Add New"), then a "Cancelled" tick box. Rows keep
the order they were added in; a wrong row is cancelled, never deleted. 25 rows as in
SonoSoft (at least 5 empty); typing in an empty row adds it.

## Follow Up Office Visit
Subjective; Better/Worse/Same; Objective Findings; Assessment; Plan.
Each follow-up is a separate historical entry/visit.
Implemented (R3, ADR-031): Patient feels (Better / Worse / Same as last visit), Subjective
statement, Subjective, Objective Findings, Assessment 1–3, Plan 1–2 with "Select".

## Laser Ablation
Implemented (R3, ADR-031) at SonoSoft's pixel positions; see ADR-031 for the field list.
Treated Vessel; start/end; Ambulatory Phlebectomy; location; incision count; method; anesthesia; relevant agents/materials; single/second pass; parameters; energy; time; treated vein length; average diameter; fluence; surgical comments; final comments; laser machine.

## Comprehensive visit tab
Vitals → Subjective → Objective → Past Medical Hx → Current Meds → Allergies → Social Hx → Physical Exam → Ultrasound (Indications/Findings/Impression) → CEAP → VCSS Right/Left → Impression → Recommendations.

Repeated UI sections must not create conflicting backend sources of truth.
