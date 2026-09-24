# Clinical Tabs — Medical V1

Global rule: preserve SonoSoft-style order and familiarity. Applicable fields support predefined options, `+ Add New`, reusable save, and visit-only free text.

## Subj Complaints Habits
Reason for visit; Problem List; Chief Complaints; characteristics; duration; progression; daily-activity impact; chest comments; comments; aggravating factors; relieving factors; previous conservative therapy + duration; family history; alcohol/exercise/tobacco; pain meds; current meds; allergies.

Reconciled in R1b (ADR-029), shown in visual groups: **Reason for visit / Problem List** (Reason for Visit, Problem List) · **Chief Complaints** (Chief Complaints, Associated condition, How long?, Symptoms getting worse over time? [checkbox, replaces the retired `progression` select], Daily Activity Impact, Additional Comments, Comments) · **Aggravating / Relieving Factors** · **Previous conservative therapy** (+ duration) · **Family history** ("Family history of VV?", the shared `family_history`) · **Habits** (Alcohol, Exercise, Tobacco) · **Medications / Allergies** (Pain Meds for CC, Current Meds, Allergies).

## Past Medical Hx
Past Medical Hx; Family Medical Hx; Unknown; Prior Test Results; Additional Comments; Surgical Hx; female-specific option/field from reference screen.

Implemented (Sprint 3A, ADR-027), in this order:
1. Past Medical Hx — multiselect, dynamic options + visit-only free text (`past_medical_history`).
2. Family Medical Hx — the EXISTING global `family_history` (same field, same history as Subj "Family History"), shown under the SonoSoft label through a placement label.
3. Unknown — checkbox (`past_medical_unknown`). Means the past medical history is unknown; it cannot coexist with any Past Medical Hx option or free text (server-enforced, the UI mirrors it; only Past Medical Hx is affected).
4. Prior Test Results — textarea (`prior_test_results`).
5. Additional Comments — textarea (`past_medical_additional_comments`, distinct from the Assessment one).
6. Surgical Hx — multiselect, dynamic options + free text (`surgical_history`).
7. Female-specific statement (`female_specific_statement`, R1b / ADR-029) — "If FEMALE select the appropriate statement; otherwise disregard": dynamic dropdown + "+ Add New" + visit-only free text. Shown only when the patient's sex is Female (hidden for Male/blank; an existing value stays visible read-only if the sex changes later). Enforced by the server.

## Assessment Plan+
Order: Impression → Recommendations → Stockings detail → Additional Comments.
Stockings structured: type, compression, gender, color, measurements.

Implemented (R1b, ADR-029; replaces the Sprint 3A version), in visual groups:
- **Impression**: `impression_rows` — 8 visible ordered rows (reusable option and/or free text per row) with Bullets / Numbers stored per visit; `impression_init_venous_interp` — "Impr for Init Venous Interp" (dynamic option + free text).
- **Recommendations**: `recommendation_rows` — 8 visible ordered rows (option and/or free text), order preserved.
- **Stockings**: Type / Compression / Gender / Color (`stockings_type`, `stockings_compression`, `stockings_gender`, `stockings_color`; single-selects with their own lists; "Gender" is the stocking cut, not the patient's sex), then Mid Thigh, Mid Calf, Mid Ankle, Floor to GF, Floor to Knee (`stockings_mid_thigh`, `stockings_mid_calf`, `stockings_mid_ankle`, `stockings_floor_to_gf`, `stockings_floor_to_knee`; numeric, cm, one decimal, one set per visit, no Right/Left split).
- Additional Comments (`assessment_additional_comments`).
Retired (history stays readable on old visits, read-only, next to its replacement): `impression`, `recommendations`, `stockings_measurements`.

## Treatment Plan
Scheduled | Completed | Recommended Treatment/Procedures in order | Approval/Status/Comments.
Future inventory linkage must not change doctor workflow.

**Deferred to Sprint 3B — not implemented.** It is a per-visit list of items with a per-item lifecycle, which the field/entry model cannot represent; it needs new tables (`treatment_plans`, `treatment_plan_items`, see DATABASE.md) and an ADR first. Open Product Owner questions are listed in ADR-027 "Deferred".

## Follow Up Office Visit
Subjective; Better/Worse/Same; Objective Findings; Assessment; Plan.
Each follow-up is a separate historical entry/visit.

## Laser Ablation
Treated Vessel; start/end; Ambulatory Phlebectomy; location; incision count; method; anesthesia; relevant agents/materials; single/second pass; parameters; energy; time; treated vein length; average diameter; fluence; surgical comments; final comments; laser machine.

## Comprehensive visit tab
Vitals → Subjective → Objective → Past Medical Hx → Current Meds → Allergies → Social Hx → Physical Exam → Ultrasound (Indications/Findings/Impression) → CEAP → VCSS Right/Left → Impression → Recommendations.

Repeated UI sections must not create conflicting backend sources of truth.
