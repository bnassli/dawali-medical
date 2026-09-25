export const FIELD_TYPES = {
  SELECT: "select",
  MULTISELECT: "multiselect",
  TEXT: "text",
  TEXTAREA: "textarea",
  /** Boolean flag stored as `checked` in the entry value (ADR-027). */
  CHECKBOX: "checkbox",
  /**
   * A number stored as canonical decimal text in `freeText` (ADR-029), e.g. "34.5".
   * Range, decimals and unit come from NUMERIC_FIELD_RULES.
   */
  NUMBER: "number",
  /**
   * One of a few fixed, non-clinical presentation choices stored in `freeText`
   * (ADR-029), e.g. "bullets" / "numbers". The values come from FIXED_CHOICES,
   * not from an option list: they are not clinical dropdown options (rule #10).
   */
  CHOICE: "choice",
  /** A calendar date stored as ISO `YYYY-MM-DD` in `freeText`, typed day/month/year (R2). */
  DATE: "date",
} as const;

export type FieldType = (typeof FIELD_TYPES)[keyof typeof FIELD_TYPES];

export function isSelectType(type: string): boolean {
  return type === FIELD_TYPES.SELECT || type === FIELD_TYPES.MULTISELECT;
}

/**
 * A GLOBAL field concept (ADR-026). `code` is unique across the whole system.
 * `optionList` names the option list it uses (default: its own code); several
 * fields may name the same list to share values. Text fields have no list.
 */
export interface FieldDefinitionSeed {
  code: string;
  label: string;
  type: FieldType;
  optionList?: string;
}

/** Placement of global fields in a section (tab), in display order. */
export interface SectionDefinitionSeed {
  code: string;
  name: string;
  sortOrder: number;
  fieldCodes: string[];
  /**
   * Presentation-only label of a placement (field code -> label), for when a
   * tab shows a global field under its SonoSoft name (e.g. "Family Medical Hx"
   * for the shared `family_history`). Never creates a second field (ADR-027).
   */
  labelOverrides?: Record<string, string>;
}

export interface ClinicalDefinitions {
  fields: FieldDefinitionSeed[];
  sections: SectionDefinitionSeed[];
}

export function optionListCodeFor(field: FieldDefinitionSeed): string | null {
  return isSelectType(field.type) ? (field.optionList ?? field.code) : null;
}

/**
 * Throws if a definitions set is internally inconsistent: duplicate global
 * field/section codes, a section placing an unknown or duplicate field, a
 * relabel of a field the section does not place, or a list on a text field.
 */
export function assertDefinitionsConsistent(defs: ClinicalDefinitions): void {
  const fieldCodes = new Set<string>();
  for (const f of defs.fields) {
    if (fieldCodes.has(f.code)) throw new Error(`Duplicate global field code "${f.code}".`);
    fieldCodes.add(f.code);
    if (!isSelectType(f.type) && f.optionList) {
      throw new Error(`Field "${f.code}" is a ${f.type} field and cannot have an option list.`);
    }
  }
  const sectionCodes = new Set<string>();
  for (const s of defs.sections) {
    if (sectionCodes.has(s.code)) throw new Error(`Duplicate section code "${s.code}".`);
    sectionCodes.add(s.code);
    const placed = new Set<string>();
    for (const code of s.fieldCodes) {
      if (!fieldCodes.has(code)) {
        throw new Error(`Section "${s.code}" places unknown field "${code}".`);
      }
      if (placed.has(code)) throw new Error(`Section "${s.code}" places field "${code}" twice.`);
      placed.add(code);
    }
    for (const [code, label] of Object.entries(s.labelOverrides ?? {})) {
      if (!placed.has(code)) {
        throw new Error(`Section "${s.code}" relabels field "${code}", which it does not place.`);
      }
      if (label.trim() === "") throw new Error(`Section "${s.code}" gives "${code}" an empty label.`);
    }
  }
}

/**
 * "Unknown"-style exclusivity (ADR-027): while the `flag` checkbox field is
 * checked on a visit, every field in `excludes` must be empty, and vice versa.
 * Enforced by the save service inside the per-visit lock (so it is race-free)
 * and mirrored in the UI; it never rewrites anything on the user's behalf.
 */
export interface ExclusionRule {
  flag: string;
  excludes: string[];
}

/** Throws if a rule names an unknown field or a flag that is not a checkbox. */
export function assertExclusionRulesConsistent(
  defs: ClinicalDefinitions,
  rules: ExclusionRule[],
): void {
  const byCode = new Map(defs.fields.map((f) => [f.code, f]));
  for (const rule of rules) {
    const flag = byCode.get(rule.flag);
    if (!flag) throw new Error(`Exclusion rule names unknown flag field "${rule.flag}".`);
    if (flag.type !== FIELD_TYPES.CHECKBOX) {
      throw new Error(`Exclusion flag "${rule.flag}" must be a checkbox field.`);
    }
    if (rule.excludes.length === 0) throw new Error(`Exclusion rule "${rule.flag}" excludes nothing.`);
    for (const code of rule.excludes) {
      if (!byCode.has(code)) {
        throw new Error(`Exclusion rule "${rule.flag}" names unknown field "${code}".`);
      }
      if (code === rule.flag) throw new Error(`Exclusion rule "${rule.flag}" excludes itself.`);
    }
  }
}

/**
 * Structural definitions only (fields, their type, section placement and
 * order). No clinical option VALUES are defined here — dropdown options are
 * data (CLAUDE.md rule #10), created through "+ Add New".
 *
 * Section and field order follow docs/CLINICAL_TABS.md and, since R1b, the
 * SonoSoft reference screens in docs/reference/sonosoft/ (ADR-029). Field CODES
 * are durable (reports and later tabs bind to them; see ADR-027 and ADR-029).
 * Because clinical entries may already exist, the seed NEVER changes an
 * existing field's type, option list or free-text flag: such a change needs a
 * migration (ADR-026). Labels and placement order may be updated here.
 */
export const SUBJ_COMPLAINTS_HABITS_SECTION_CODE = "subj_complaints_habits";
export const PAST_MEDICAL_HX_SECTION_CODE = "past_medical_hx";
export const ASSESSMENT_PLAN_SECTION_CODE = "assessment_plan";
export const TREATMENT_PLAN_SECTION_CODE = "treatment_plan";

/** Assessment Plan+ shows 8 ordered Impression rows and 8 Recommendation rows (AP1/AP2). */
export const IMPRESSION_ROWS = 8;
export const RECOMMENDATION_ROWS = 8;

function rowCodes(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}_${i + 1}`);
}

/** One single-select field per row; all rows of a list share one option list. */
function rowFields(
  prefix: string,
  label: string,
  optionList: string,
  count: number,
): FieldDefinitionSeed[] {
  return rowCodes(prefix, count).map((code, i) => ({
    code,
    label: `${label} ${i + 1}`,
    type: FIELD_TYPES.SELECT,
    optionList,
  }));
}

export const CLINICAL_FIELD_DEFINITIONS: FieldDefinitionSeed[] = [
  // --- Subj Complaints Habits. Labels are SonoSoft's, word for word (R1b, ADR-029). ---
  { code: "reason_for_visit", label: "Reason for visit", type: FIELD_TYPES.SELECT },
  { code: "problem_list", label: "Problem List", type: FIELD_TYPES.MULTISELECT },
  { code: "chief_complaints", label: "Chief Complaints", type: FIELD_TYPES.MULTISELECT },
  { code: "characteristics", label: "associated with", type: FIELD_TYPES.MULTISELECT },
  { code: "duration", label: "How long?", type: FIELD_TYPES.SELECT },
  {
    code: "symptoms_worse",
    label: "Symptoms getting worse over time?",
    type: FIELD_TYPES.CHECKBOX,
  },
  { code: "progression", label: "Progression", type: FIELD_TYPES.SELECT },
  {
    code: "daily_activity_impact",
    label: "Affects daily living activities?",
    type: FIELD_TYPES.SELECT,
  },
  { code: "chest_comments", label: "Chest comments", type: FIELD_TYPES.TEXTAREA },
  { code: "comments", label: "Comment", type: FIELD_TYPES.TEXTAREA },
  { code: "aggravating_factors", label: "Aggravating Factors", type: FIELD_TYPES.MULTISELECT },
  { code: "relieving_factors", label: "Relieving Factors", type: FIELD_TYPES.MULTISELECT },
  {
    code: "previous_conservative_therapy",
    label: "Previous conservative therapy",
    type: FIELD_TYPES.MULTISELECT,
  },
  {
    code: "previous_conservative_therapy_duration",
    label: "How long? (therapy)",
    type: FIELD_TYPES.SELECT,
  },
  // Family History (general) is shown only in Past Medical Hx as "Family Medical Hx".
  // Subj asks the separate varicose-vein question (S1, ADR-029).
  { code: "family_history", label: "Family History", type: FIELD_TYPES.MULTISELECT },
  { code: "family_history_vv", label: "Family history of VV?", type: FIELD_TYPES.SELECT },
  { code: "alcohol", label: "Alcohol", type: FIELD_TYPES.SELECT },
  { code: "exercise", label: "Exercise", type: FIELD_TYPES.SELECT },
  { code: "tobacco", label: "Tobacco use", type: FIELD_TYPES.SELECT },
  { code: "pain_meds", label: "Pain Meds for CC", type: FIELD_TYPES.MULTISELECT },
  { code: "current_meds", label: "Current Meds", type: FIELD_TYPES.MULTISELECT },
  { code: "current_meds_none", label: "None", type: FIELD_TYPES.CHECKBOX },
  { code: "allergies", label: "Allergies", type: FIELD_TYPES.MULTISELECT },
  { code: "allergies_no_known", label: "No known", type: FIELD_TYPES.CHECKBOX },

  // --- Past Medical Hx ---
  { code: "past_medical_history", label: "Past Medical Hx", type: FIELD_TYPES.MULTISELECT },
  // Unknown sits under Family Medical Hx in SonoSoft (P1). Replaces the retired
  // `past_medical_unknown` (migration 0007), which keeps its history read-only.
  { code: "family_history_unknown", label: "Unknown", type: FIELD_TYPES.CHECKBOX },
  { code: "prior_test_results", label: "Prior Test Results", type: FIELD_TYPES.TEXTAREA },
  {
    // Dropdown with free text in SonoSoft (P3); was a textarea (type changed by migration 0007).
    code: "past_medical_additional_comments",
    label: "Additional Comments",
    type: FIELD_TYPES.SELECT,
  },
  { code: "surgical_history", label: "Surgical Hx", type: FIELD_TYPES.MULTISELECT },
  {
    code: "female_statement",
    label: "If FEMALE select the appropriate statement; otherwise disregard",
    type: FIELD_TYPES.SELECT,
  },

  // --- Assessment Plan+. Ordered rows share one option list per concept (AP1/AP2). ---
  ...rowFields("impression", "Impression", "impression", IMPRESSION_ROWS),
  {
    code: "impr_for_init_venous_interp",
    label: "Impr for Init Venous Interp",
    type: FIELD_TYPES.SELECT,
  },
  { code: "impression_list_style", label: "Bullets / Numbers", type: FIELD_TYPES.CHOICE },
  ...rowFields("recommendation", "Recommendation", "recommendations", RECOMMENDATION_ROWS),
  { code: "stockings_type", label: "Type", type: FIELD_TYPES.SELECT },
  { code: "stockings_compression", label: "Compression", type: FIELD_TYPES.SELECT },
  { code: "stockings_gender", label: "Gender", type: FIELD_TYPES.SELECT },
  { code: "stockings_color", label: "Color", type: FIELD_TYPES.SELECT },
  { code: "stockings_mid_thigh", label: "Mid Thigh", type: FIELD_TYPES.NUMBER },
  { code: "stockings_mid_calf", label: "Mid Calf", type: FIELD_TYPES.NUMBER },
  { code: "stockings_mid_ankle", label: "Mid Ankle", type: FIELD_TYPES.NUMBER },
  { code: "stockings_floor_to_gf", label: "Floor To GF", type: FIELD_TYPES.NUMBER },
  { code: "stockings_floor_to_knee", label: "Floor To Knee", type: FIELD_TYPES.NUMBER },
  {
    code: "assessment_additional_comments",
    label: "Additional Comments",
    type: FIELD_TYPES.TEXTAREA,
  },

  // --- Laser Ablation (R3, ADR-031): SonoSoft's labels; every list starts empty. ---
  { code: "laser_side", label: "Treated Vessel side", type: FIELD_TYPES.SELECT },
  { code: "laser_vessel", label: "Treated Vessel", type: FIELD_TYPES.SELECT },
  { code: "laser_start_cm", label: "beginning at (cm from the junction)", type: FIELD_TYPES.TEXT },
  { code: "laser_terminated_at", label: "terminated at the", type: FIELD_TYPES.SELECT },
  { code: "laser_phlebectomy_location", label: "Ambulatory Phlebectomy Location", type: FIELD_TYPES.SELECT },
  { code: "laser_incisions", label: "# of incisions", type: FIELD_TYPES.SELECT },
  { code: "laser_phlebectomy_using", label: "using", type: FIELD_TYPES.SELECT },
  { code: "laser_anesthesia", label: "Anesthesia", type: FIELD_TYPES.SELECT },
  { code: "laser_cleansed_with", label: "Cleansed with", type: FIELD_TYPES.SELECT },
  ...[1, 2, 3].flatMap((i): FieldDefinitionSeed[] => [
    { code: `laser_agent_${i}_amount`, label: `Agent ${i} amount`, type: FIELD_TYPES.SELECT, optionList: "laser_agent_amount" },
    { code: `laser_agent_${i}`, label: `Agent ${i}`, type: FIELD_TYPES.SELECT, optionList: "laser_agent" },
  ]),
  { code: "laser_entry_point", label: "Entry point", type: FIELD_TYPES.SELECT },
  { code: "laser_pass1_to", label: "to the (single pass)", type: FIELD_TYPES.SELECT, optionList: "laser_pass_end" },
  { code: "laser_pass2_from", label: "then from the", type: FIELD_TYPES.SELECT },
  { code: "laser_pass2_to", label: "to the (2nd pass)", type: FIELD_TYPES.SELECT, optionList: "laser_pass_end" },
  { code: "laser_parameters", label: "Treatment Parameters", type: FIELD_TYPES.SELECT },
  { code: "laser_changed_at", label: "Treatment was CHANGED at the", type: FIELD_TYPES.SELECT },
  { code: "laser_changed_to", label: "Treatment changed to", type: FIELD_TYPES.SELECT },
  { code: "laser_changed_value", label: "Changed value", type: FIELD_TYPES.TEXT },
  { code: "laser_energy_joules", label: "Total laser energy used was (joules)", type: FIELD_TYPES.SELECT },
  { code: "laser_seconds", label: "seconds", type: FIELD_TYPES.SELECT },
  { code: "laser_length_treated", label: "Total length of vein treated", type: FIELD_TYPES.SELECT },
  { code: "laser_avg_diameter", label: "Average Dia.of Vein", type: FIELD_TYPES.TEXT },
  { code: "laser_optional", label: "OPTIONAL", type: FIELD_TYPES.SELECT },
  { code: "laser_optional_value", label: "OPTIONAL value", type: FIELD_TYPES.TEXT },
  { code: "laser_fluence", label: "Fluence", type: FIELD_TYPES.TEXT },
  { code: "laser_surgical_comments", label: "Add'l Surgical Comments", type: FIELD_TYPES.SELECT },
  { code: "laser_final_comments", label: "Final Comments", type: FIELD_TYPES.SELECT },
  { code: "laser_machine", label: "Laser Machine", type: FIELD_TYPES.SELECT },

  // --- Follow Up Office Visit (R3, ADR-031). Each follow-up is its own visit. ---
  { code: "followup_patient_feels", label: "Patient feels", type: FIELD_TYPES.CHOICE },
  { code: "followup_subjective_statement", label: "Subjective statement", type: FIELD_TYPES.SELECT },
  { code: "followup_subjective", label: "Subjective", type: FIELD_TYPES.SELECT },
  { code: "followup_objective", label: "Objective Findings", type: FIELD_TYPES.SELECT },
  ...rowFields("followup_assessment", "Assessment", "followup_assessment", 3),
  ...rowFields("followup_plan", "Plan", "followup_plan", 2),

  // --- Treatment Plan (R2, ADR-030): the columns of the patient's plan table.
  // Placed in no tab: their values live in treatment_plan_entries, per plan row. ---
  { code: "treatment_scheduled", label: "Scheduled", type: FIELD_TYPES.DATE },
  { code: "treatment_completed", label: "Completed", type: FIELD_TYPES.DATE },
  {
    code: "treatment_procedure",
    label: "Recommended Treatment/Procedures in the order to be received",
    type: FIELD_TYPES.SELECT,
  },
  { code: "treatment_status", label: "Approval/Status/Comments", type: FIELD_TYPES.SELECT },
  { code: "treatment_cancelled", label: "Cancelled", type: FIELD_TYPES.CHECKBOX },
];

/**
 * Fields retired by R1b (migration 0007 sets is_active = false and moves their
 * placements to the end of the tab). They are no longer defined here, so the
 * seed never re-creates them on a fresh database; on existing databases their
 * history stays visible read-only (ADR-026).
 */
export const RETIRED_FIELD_CODES = [
  "past_medical_unknown",
  "impression",
  "recommendations",
  "stockings_measurements",
] as const;

/**
 * EXPLICIT placement per section. Never derive a section's fields from the
 * whole field list: the seed never removes placements, so a field placed by
 * mistake would stay in that tab in every database it reached.
 */
export const SUBJ_COMPLAINTS_HABITS_FIELD_CODES = [
  "reason_for_visit",
  "problem_list",
  "chief_complaints",
  "characteristics",
  "duration",
  "symptoms_worse",
  "progression",
  "daily_activity_impact",
  "chest_comments",
  "comments",
  "aggravating_factors",
  "relieving_factors",
  "previous_conservative_therapy",
  "previous_conservative_therapy_duration",
  "family_history_vv",
  "alcohol",
  "exercise",
  "tobacco",
  "pain_meds",
  "current_meds",
  "current_meds_none",
  "allergies",
  "allergies_no_known",
];

/** SonoSoft order (P1-P3): Unknown under Family Medical Hx; the female statement last. */
export const PAST_MEDICAL_HX_FIELD_CODES = [
  "past_medical_history",
  "family_history",
  "family_history_unknown",
  "prior_test_results",
  "past_medical_additional_comments",
  "surgical_history",
  "female_statement",
];

export const ASSESSMENT_PLAN_FIELD_CODES = [
  ...rowCodes("impression", IMPRESSION_ROWS),
  "impr_for_init_venous_interp",
  "impression_list_style",
  ...rowCodes("recommendation", RECOMMENDATION_ROWS),
  "stockings_type",
  "stockings_compression",
  "stockings_gender",
  "stockings_color",
  "stockings_mid_thigh",
  "stockings_mid_calf",
  "stockings_mid_ankle",
  "stockings_floor_to_gf",
  "stockings_floor_to_knee",
  "assessment_additional_comments",
];

export const LASER_ABLATION_FIELD_CODES = [
  "laser_side",
  "laser_vessel",
  "laser_start_cm",
  "laser_terminated_at",
  "laser_phlebectomy_location",
  "laser_incisions",
  "laser_phlebectomy_using",
  "laser_anesthesia",
  "laser_cleansed_with",
  ...[1, 2, 3].flatMap((i) => [`laser_agent_${i}_amount`, `laser_agent_${i}`]),
  "laser_entry_point",
  "laser_pass1_to",
  "laser_pass2_from",
  "laser_pass2_to",
  "laser_parameters",
  "laser_changed_at",
  "laser_changed_to",
  "laser_changed_value",
  "laser_energy_joules",
  "laser_seconds",
  "laser_length_treated",
  "laser_avg_diameter",
  "laser_optional",
  "laser_optional_value",
  "laser_fluence",
  "laser_surgical_comments",
  "laser_final_comments",
  "laser_machine",
];

export const FOLLOW_UP_FIELD_CODES = [
  "followup_patient_feels",
  "followup_subjective_statement",
  "followup_subjective",
  "followup_objective",
  ...rowCodes("followup_assessment", 3),
  ...rowCodes("followup_plan", 2),
];

export const CLINICAL_SECTIONS: SectionDefinitionSeed[] = [
  {
    code: SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    name: "Subj Complaints Habits",
    sortOrder: 1,
    fieldCodes: SUBJ_COMPLAINTS_HABITS_FIELD_CODES,
  },
  {
    code: PAST_MEDICAL_HX_SECTION_CODE,
    name: "Past Medical Hx",
    sortOrder: 2,
    fieldCodes: PAST_MEDICAL_HX_FIELD_CODES,
    labelOverrides: { family_history: "Family Medical Hx" },
  },
  {
    code: ASSESSMENT_PLAN_SECTION_CODE,
    name: "Assessment Plan+",
    sortOrder: 3,
    fieldCodes: ASSESSMENT_PLAN_FIELD_CODES,
  },
  {
    // The patient's Treatment Plan table (R2, ADR-030). No placed fields: its
    // columns are TREATMENT_PLAN_COLUMN_CODES and its rows are plan items.
    code: TREATMENT_PLAN_SECTION_CODE,
    name: "Treatment Plan",
    sortOrder: 4,
    fieldCodes: [],
  },
  // SonoSoft's Treatment set order: Treatment Plan, Laser Ablation, ..., Follow Up Office Visit.
  { code: "laser_ablation", name: "Laser Ablation", sortOrder: 5, fieldCodes: LASER_ABLATION_FIELD_CODES },
  { code: "follow_up_office_visit", name: "Follow Up Office Visit", sortOrder: 6, fieldCodes: FOLLOW_UP_FIELD_CODES },
];

/**
 * A checkbox that rules out values in another field on the same visit
 * (ADR-027 mechanism). Enforced by the server inside the visit lock; the UI
 * only disables the counterpart.
 */
export const FIELD_EXCLUSION_RULES: ExclusionRule[] = [
  { flag: "family_history_unknown", excludes: ["family_history"] },
  { flag: "current_meds_none", excludes: ["current_meds"] },
  { flag: "allergies_no_known", excludes: ["allergies"] },
];

/**
 * Fields that may only hold a value for a female patient (`patients.sex = 'F'`).
 * The UI keeps them in their SonoSoft position but disabled otherwise; the
 * server refuses a non-empty value (P2, ADR-029). Clearing is always allowed.
 */
/**
 * Treatment Plan (R2, ADR-030): one table per PATIENT, shared by all visits.
 * Each row is a treatment_plan_items row; each cell is versioned in
 * treatment_plan_entries under one of these column fields. The columns never
 * take per-visit clinical entries.
 */
export const TREATMENT_PLAN_COLUMN_CODES = [
  "treatment_scheduled",
  "treatment_completed",
  "treatment_procedure",
  "treatment_status",
  "treatment_cancelled",
] as const;

/** SonoSoft shows 25 rows; at least this many empty rows follow the filled ones. */
export const TREATMENT_PLAN_MIN_ROWS = 25;
export const TREATMENT_PLAN_MIN_EMPTY_ROWS = 5;

export const FEMALE_ONLY_FIELD_CODES: readonly string[] = ["female_statement"];

export interface NumericFieldRule {
  min: number;
  max: number;
  /** Maximum digits after the decimal point. */
  decimals: number;
  unit: string;
}

/** Stocking measurements: one set per visit, centimetres (AP5; unit is an open PO question). */
export const STOCKING_MEASUREMENT_UNIT = "cm";
const STOCKING_RULE: NumericFieldRule = { min: 0, max: 200, decimals: 1, unit: STOCKING_MEASUREMENT_UNIT };

export const NUMERIC_FIELD_RULES: Record<string, NumericFieldRule> = {
  stockings_mid_thigh: STOCKING_RULE,
  stockings_mid_calf: STOCKING_RULE,
  stockings_mid_ankle: STOCKING_RULE,
  stockings_floor_to_gf: STOCKING_RULE,
  stockings_floor_to_knee: STOCKING_RULE,
};

/** Fixed values of `choice` fields (presentation only, never clinical options). */
export const FIXED_CHOICES: Record<string, readonly { value: string; label: string }[]> = {
  // Fixed by the requirements (§6.5) and SonoSoft's three radio buttons.
  followup_patient_feels: [
    { value: "better", label: "Better" },
    { value: "worse", label: "Worse" },
    { value: "same", label: "Same as last visit" },
  ],
  impression_list_style: [
    { value: "bullets", label: "Bullets" },
    { value: "numbers", label: "Numbers" },
  ],
};

/** Throws if a number/choice field has no rule, or a rule names an unknown field. */
export function assertFieldRulesConsistent(defs: ClinicalDefinitions): void {
  const byCode = new Map(defs.fields.map((f) => [f.code, f]));
  for (const f of defs.fields) {
    if (f.type === FIELD_TYPES.NUMBER && !NUMERIC_FIELD_RULES[f.code]) {
      throw new Error(`Number field "${f.code}" has no NUMERIC_FIELD_RULES entry.`);
    }
    if (f.type === FIELD_TYPES.CHOICE && !FIXED_CHOICES[f.code]?.length) {
      throw new Error(`Choice field "${f.code}" has no FIXED_CHOICES entry.`);
    }
  }
  for (const code of [...Object.keys(NUMERIC_FIELD_RULES), ...Object.keys(FIXED_CHOICES), ...FEMALE_ONLY_FIELD_CODES]) {
    if (!byCode.has(code)) throw new Error(`Field rule names unknown field "${code}".`);
  }
  const placed = new Set(defs.sections.flatMap((s) => s.fieldCodes));
  for (const code of TREATMENT_PLAN_COLUMN_CODES) {
    if (!byCode.has(code)) throw new Error(`Treatment Plan column "${code}" is not defined.`);
    if (placed.has(code)) throw new Error(`Treatment Plan column "${code}" must not be placed in a tab.`);
  }
}

export const DEFAULT_CLINICAL_DEFINITIONS: ClinicalDefinitions = {
  fields: CLINICAL_FIELD_DEFINITIONS,
  sections: CLINICAL_SECTIONS,
};

assertDefinitionsConsistent(DEFAULT_CLINICAL_DEFINITIONS);
assertExclusionRulesConsistent(DEFAULT_CLINICAL_DEFINITIONS, FIELD_EXCLUSION_RULES);
assertFieldRulesConsistent(DEFAULT_CLINICAL_DEFINITIONS);
