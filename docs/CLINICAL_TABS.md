# Clinical Tabs — Medical V1

Global rule: preserve SonoSoft-style order and familiarity. Applicable fields support predefined options, `+ Add New`, reusable save, and visit-only free text.

## Subj Complaints Habits
Reason for visit; Problem List; Chief Complaints; characteristics; duration; progression; daily-activity impact; chest comments; comments; aggravating factors; relieving factors; previous conservative therapy + duration; family history; alcohol/exercise/tobacco; pain meds; current meds; allergies.

## Past Medical Hx
Past Medical Hx; Family Medical Hx; Unknown; Prior Test Results; Additional Comments; Surgical Hx; female-specific option/field from reference screen.

Implemented (Sprint 3A, ADR-027), in this order:
1. Past Medical Hx — multiselect, dynamic options + visit-only free text (`past_medical_history`).
2. Family Medical Hx — the EXISTING global `family_history` (same field, same history as Subj "Family History"), shown under the SonoSoft label through a placement label.
3. Unknown — checkbox (`past_medical_unknown`). Means the past medical history is unknown; it cannot coexist with any Past Medical Hx option or free text (server-enforced, the UI mirrors it; only Past Medical Hx is affected).
4. Prior Test Results — textarea (`prior_test_results`).
5. Additional Comments — textarea (`past_medical_additional_comments`, distinct from the Assessment one).
6. Surgical Hx — multiselect, dynamic options + free text (`surgical_history`).
7. Female-specific field — **deferred** until a SonoSoft reference screen is supplied (no field, no conditional visibility). It is last in this tab, so adding it later is a seed-only addition that does not disturb the order above.

## Assessment Plan+
Order: Impression → Recommendations → Stockings detail → Additional Comments.
Stockings structured: type, compression, gender, color, measurements.

Implemented (Sprint 3A, ADR-027), in this order: Impression (`impression`, multiselect + free text) -> Recommendations (`recommendations`, multiselect + free text) -> Stockings Type / Compression / Gender / Color (`stockings_type`, `stockings_compression`, `stockings_gender`, `stockings_color`; each a single-select with its own dynamic option list) -> Stockings Measurements (`stockings_measurements`, textarea) -> Additional Comments (`assessment_additional_comments`). Each stocking field is independent per visit (own version stream and audit trail); there is no top-level yes/no and nothing is derived from patient demographics. "Gender" is the stocking cut, not the patient's sex.

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
