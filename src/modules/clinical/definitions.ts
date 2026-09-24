export const FIELD_TYPES = {
  SELECT: "select",
  MULTISELECT: "multiselect",
  TEXT: "text",
  TEXTAREA: "textarea",
  /** Boolean flag stored as `checked` in the entry value (ADR-027). */
  CHECKBOX: "checkbox",
  /**
   * Visible ordered rows, each a reusable option and/or free text, stored as
   * `rows` in the entry value (ADR-029). Uses an option list like a select.
   */
  ORDERED_LIST: "ordered_list",
  /** A structured numeric value (e.g. centimetres), stored as `numberValue` (ADR-029). */
  NUMBER: "number",
} as const;

export type FieldType = (typeof FIELD_TYPES)[keyof typeof FIELD_TYPES];

export function isSelectType(type: string): boolean {
  return type === FIELD_TYPES.SELECT || type === FIELD_TYPES.MULTISELECT;
}

/** Field types that draw on an option list (and so support "+ Add New"). */
export function hasOptionList(type: string): boolean {
  return isSelectType(type) || type === FIELD_TYPES.ORDERED_LIST;
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
  /**
   * Retired (ADR-026/029): kept, never deleted, so existing history stays
   * readable on the visits that have it; hidden elsewhere and not editable.
   * One-way: the seed sets is_active = false and never reactivates.
   */
  retired?: boolean;
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
  /**
   * Presentation-only visual group of a placement (field code -> group
   * heading), stored as clinical_section_fields.group_label (ADR-029).
   * Consecutive fields with the same group are rendered in one block.
   */
  groups?: Record<string, string>;
}

export interface ClinicalDefinitions {
  fields: FieldDefinitionSeed[];
  sections: SectionDefinitionSeed[];
}

export function optionListCodeFor(field: FieldDefinitionSeed): string | null {
  return hasOptionList(field.type) ? (field.optionList ?? field.code) : null;
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
    if (!hasOptionList(f.type) && f.optionList) {
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
    for (const [code, group] of Object.entries(s.groups ?? {})) {
      if (!placed.has(code)) {
        throw new Error(`Section "${s.code}" groups field "${code}", which it does not place.`);
      }
      if (group.trim() === "") throw new Error(`Section "${s.code}" gives "${code}" an empty group.`);
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
 * Section and field order follow docs/CLINICAL_TABS.md and, since R1b,
 * docs/FINAL_V1_REQUIREMENTS_RECONCILIATION.md §6.1–6.3 (ADR-029). Field CODES
 * are durable (reports and later tabs bind to them): a code is never renamed or
 * re-typed; it is retired (`retired: true`) and replaced by a new code, and its
 * history stays readable on the visits that have it. Because clinical entries
 * may already exist, the seed NEVER changes an existing field's type, option
 * list or free-text flag (ADR-026). Labels, groups and placement order may be
 * updated here.
 */
export const SUBJ_COMPLAINTS_HABITS_SECTION_CODE = "subj_complaints_habits";
export const PAST_MEDICAL_HX_SECTION_CODE = "past_medical_hx";
export const ASSESSMENT_PLAN_SECTION_CODE = "assessment_plan";

export const CLINICAL_FIELD_DEFINITIONS: FieldDefinitionSeed[] = [
  // --- Subj Complaints Habits (Sprint 2; labels/checkbox reconciled in R1b) ---
  { code: "reason_for_visit", label: "Reason for Visit", type: FIELD_TYPES.SELECT },
  { code: "problem_list", label: "Problem List", type: FIELD_TYPES.MULTISELECT },
  { code: "chief_complaints", label: "Chief Complaints", type: FIELD_TYPES.MULTISELECT },
  { code: "characteristics", label: "Associated condition", type: FIELD_TYPES.MULTISELECT },
  { code: "duration", label: "Duration", type: FIELD_TYPES.SELECT },
  // Retired in R1b: the SonoSoft screen has a checkbox here (symptoms_worse_over_time).
  { code: "progression", label: "Progression", type: FIELD_TYPES.SELECT, retired: true },
  {
    code: "symptoms_worse_over_time",
    label: "Symptoms getting worse over time?",
    type: FIELD_TYPES.CHECKBOX,
  },
  {
    code: "daily_activity_impact",
    label: "Affects daily living activities?",
    type: FIELD_TYPES.SELECT,
  },
  // Code kept from Sprint 2 (codes are durable); the SonoSoft label is "Additional Comments".
  { code: "chest_comments", label: "Additional Comments", type: FIELD_TYPES.TEXTAREA },
  // SonoSoft "Comment": a separate field from "Additional Comments" (chest_comments).
  { code: "comments", label: "Comment", type: FIELD_TYPES.TEXTAREA },
  { code: "aggravating_factors", label: "Aggravating Factors", type: FIELD_TYPES.MULTISELECT },
  { code: "relieving_factors", label: "Relieving Factors", type: FIELD_TYPES.MULTISELECT },
  {
    code: "previous_conservative_therapy",
    label: "Previous Conservative Therapy",
    type: FIELD_TYPES.MULTISELECT,
  },
  {
    code: "previous_conservative_therapy_duration",
    label: "Previous Conservative Therapy Duration",
    type: FIELD_TYPES.SELECT,
  },
  { code: "family_history", label: "Family History", type: FIELD_TYPES.MULTISELECT },
  { code: "alcohol", label: "Alcohol", type: FIELD_TYPES.SELECT },
  { code: "exercise", label: "Exercise", type: FIELD_TYPES.SELECT },
  { code: "tobacco", label: "Tobacco", type: FIELD_TYPES.SELECT },
  { code: "pain_meds", label: "Pain Meds for CC", type: FIELD_TYPES.MULTISELECT },
  { code: "current_meds", label: "Current Meds", type: FIELD_TYPES.MULTISELECT },
  { code: "allergies", label: "Allergies", type: FIELD_TYPES.MULTISELECT },

  // --- Past Medical Hx (Sprint 3A; female-specific statement added in R1b). "Family
  // Medical Hx" is NOT defined here: it is the existing global `family_history`. ---
  { code: "past_medical_history", label: "Past Medical Hx", type: FIELD_TYPES.MULTISELECT },
  { code: "past_medical_unknown", label: "Unknown", type: FIELD_TYPES.CHECKBOX },
  { code: "prior_test_results", label: "Prior Test Results", type: FIELD_TYPES.TEXTAREA },
  {
    code: "past_medical_additional_comments",
    label: "Additional Comments",
    type: FIELD_TYPES.TEXTAREA,
  },
  { code: "surgical_history", label: "Surgical Hx", type: FIELD_TYPES.MULTISELECT },
  {
    code: "female_specific_statement",
    label: "If FEMALE select the appropriate statement; otherwise disregard",
    type: FIELD_TYPES.SELECT,
  },

  // --- Assessment Plan+ (Sprint 3A; reconciled in R1b) ---
  // Retired in R1b (replaced by ordered rows / structured measurements; ADR-029).
  { code: "impression", label: "Impression", type: FIELD_TYPES.MULTISELECT, retired: true },
  {
    code: "recommendations",
    label: "Recommendations",
    type: FIELD_TYPES.MULTISELECT,
    retired: true,
  },
  {
    code: "stockings_measurements",
    label: "Stockings Measurements",
    type: FIELD_TYPES.TEXTAREA,
    retired: true,
  },
  // The ordered rows REUSE the retired fields' option lists, so every option already
  // added under Impression / Recommendations stays available.
  {
    code: "impression_rows",
    label: "Impression",
    type: FIELD_TYPES.ORDERED_LIST,
    optionList: "impression",
  },
  {
    code: "impression_init_venous_interp",
    label: "Impr for Init Venous Interp",
    type: FIELD_TYPES.SELECT,
  },
  {
    code: "recommendation_rows",
    label: "Recommendations",
    type: FIELD_TYPES.ORDERED_LIST,
    optionList: "recommendations",
  },
  { code: "stockings_type", label: "Stockings Type", type: FIELD_TYPES.SELECT },
  { code: "stockings_compression", label: "Stockings Compression", type: FIELD_TYPES.SELECT },
  { code: "stockings_gender", label: "Stockings Gender", type: FIELD_TYPES.SELECT },
  { code: "stockings_color", label: "Stockings Color", type: FIELD_TYPES.SELECT },
  { code: "stockings_mid_thigh", label: "Mid Thigh", type: FIELD_TYPES.NUMBER },
  { code: "stockings_mid_calf", label: "Mid Calf", type: FIELD_TYPES.NUMBER },
  { code: "stockings_mid_ankle", label: "Mid Ankle", type: FIELD_TYPES.NUMBER },
  { code: "stockings_floor_to_gf", label: "Floor to GF", type: FIELD_TYPES.NUMBER },
  { code: "stockings_floor_to_knee", label: "Floor to Knee", type: FIELD_TYPES.NUMBER },
  {
    code: "assessment_additional_comments",
    label: "Additional Comments",
    type: FIELD_TYPES.TEXTAREA,
  },
];

/**
 * EXPLICIT placement per section. Never derive a section's fields from the
 * whole field list: the seed never removes placements, so a field placed by
 * mistake would stay in that tab in every database it reached. Retired fields
 * stay placed where they were, so their history renders in its old position.
 */
export const SUBJ_COMPLAINTS_HABITS_FIELD_CODES = [
  "reason_for_visit",
  "problem_list",
  "chief_complaints",
  "characteristics",
  "duration",
  "progression",
  "symptoms_worse_over_time",
  "daily_activity_impact",
  "chest_comments",
  "comments",
  "aggravating_factors",
  "relieving_factors",
  "previous_conservative_therapy",
  "previous_conservative_therapy_duration",
  "family_history",
  "alcohol",
  "exercise",
  "tobacco",
  "pain_meds",
  "current_meds",
  "allergies",
];

/** Visual blocks of Subj Complaints Habits (FINAL_V1 §6.1: never one flat list). */
const SUBJ_GROUPS: Record<string, string[]> = {
  "Reason for visit / Problem List": ["reason_for_visit", "problem_list"],
  "Chief Complaints": [
    "chief_complaints",
    "characteristics",
    "duration",
    "progression",
    "symptoms_worse_over_time",
    "daily_activity_impact",
    "chest_comments",
    "comments",
  ],
  "Aggravating / Relieving Factors": ["aggravating_factors", "relieving_factors"],
  "Previous conservative therapy": [
    "previous_conservative_therapy",
    "previous_conservative_therapy_duration",
  ],
  "Family history": ["family_history"],
  Habits: ["alcohol", "exercise", "tobacco"],
  "Medications / Allergies": ["pain_meds", "current_meds", "allergies"],
};

/** FINAL_V1 §6.2 order; the female-specific statement is 7th. */
export const PAST_MEDICAL_HX_FIELD_CODES = [
  "past_medical_history",
  "family_history",
  "past_medical_unknown",
  "prior_test_results",
  "past_medical_additional_comments",
  "surgical_history",
  "female_specific_statement",
];

/** Impression -> Recommendations -> Stockings detail -> Additional Comments (FINAL_V1 §6.3). */
export const ASSESSMENT_PLAN_FIELD_CODES = [
  "impression",
  "impression_rows",
  "impression_init_venous_interp",
  "recommendations",
  "recommendation_rows",
  "stockings_type",
  "stockings_compression",
  "stockings_gender",
  "stockings_color",
  "stockings_mid_thigh",
  "stockings_mid_calf",
  "stockings_mid_ankle",
  "stockings_floor_to_gf",
  "stockings_floor_to_knee",
  "stockings_measurements",
  "assessment_additional_comments",
];

const ASSESSMENT_GROUPS: Record<string, string[]> = {
  Impression: ["impression", "impression_rows", "impression_init_venous_interp"],
  Recommendations: ["recommendations", "recommendation_rows"],
  Stockings: [
    "stockings_type",
    "stockings_compression",
    "stockings_gender",
    "stockings_color",
    "stockings_mid_thigh",
    "stockings_mid_calf",
    "stockings_mid_ankle",
    "stockings_floor_to_gf",
    "stockings_floor_to_knee",
    "stockings_measurements",
  ],
};

/** { group: [codes] } -> { code: group } */
function groupsByField(groups: Record<string, string[]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [group, codes] of Object.entries(groups)) {
    for (const code of codes) result[code] = group;
  }
  return result;
}

export const CLINICAL_SECTIONS: SectionDefinitionSeed[] = [
  {
    code: SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    name: "Subj Complaints Habits",
    sortOrder: 1,
    fieldCodes: SUBJ_COMPLAINTS_HABITS_FIELD_CODES,
    // Two SonoSoft "How long?" fields: the complaint's and the previous therapy's.
    labelOverrides: {
      duration: "How long?",
      previous_conservative_therapy_duration: "How long?",
      family_history: "Family history of VV?",
    },
    groups: groupsByField(SUBJ_GROUPS),
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
    groups: groupsByField(ASSESSMENT_GROUPS),
  },
];

/** "Unknown" past medical history cannot coexist with Past Medical Hx values. */
export const FIELD_EXCLUSION_RULES: ExclusionRule[] = [
  { flag: "past_medical_unknown", excludes: ["past_medical_history"] },
];

// --- Per-field behaviour (code-level, like the exclusion rules; ADR-029) ---

/** Hard upper bound on rows of any ordered-list field (also bounds the request body). */
export const MAX_ORDERED_ROWS = 20;

/** Max characters of the free text of ONE ordered-list row. */
export const MAX_ROW_TEXT_LENGTH = 1000;

export interface OrderedListConfig {
  /** Number of visible rows (the maximum a value may hold). */
  rows: number;
  /** Whether the value carries a Bullets / Numbers display mode. */
  displayMode: boolean;
}

export const ORDERED_LIST_CONFIG: Record<string, OrderedListConfig> = {
  impression_rows: { rows: 8, displayMode: true },
  recommendation_rows: { rows: 8, displayMode: false },
};

export interface NumberFieldConfig {
  unit: string;
  min: number;
  max: number;
  /** Maximum decimal places accepted. */
  decimals: number;
}

const STOCKING_CM: NumberFieldConfig = { unit: "cm", min: 0, max: 300, decimals: 1 };

export const NUMBER_FIELD_CONFIG: Record<string, NumberFieldConfig> = {
  stockings_mid_thigh: STOCKING_CM,
  stockings_mid_calf: STOCKING_CM,
  stockings_mid_ankle: STOCKING_CM,
  stockings_floor_to_gf: STOCKING_CM,
  stockings_floor_to_knee: STOCKING_CM,
};

/**
 * A field that only applies to some patients (ADR-029). While the patient does
 * not match, the field is hidden when empty (shown read-only when it already
 * holds a value, so history never disappears) and the server refuses any new
 * non-empty value. Clearing is always allowed.
 */
export interface PatientConditionRule {
  field: string;
  /** Required patients.sex code. */
  patientSex: "F" | "M";
  /** Shown when an existing value is kept read-only because the patient no longer matches. */
  readOnlyReason: string;
}

export const PATIENT_CONDITION_RULES: PatientConditionRule[] = [
  {
    field: "female_specific_statement",
    patientSex: "F",
    readOnlyReason:
      "Recorded while the patient's sex was Female; read-only because the patient is not currently recorded as Female.",
  },
];

/**
 * Throws if a per-field config is inconsistent with the definitions: every
 * ordered-list / number field needs its config, and a config must name a field
 * of the right type. `complete` (the default set) also requires every config
 * and condition to name a defined field; partial sets (e.g. in tests) skip that.
 */
export function assertFieldConfigConsistent(
  defs: ClinicalDefinitions,
  options: { complete?: boolean } = {},
): void {
  const complete = options.complete ?? true;
  const byCode = new Map(defs.fields.map((f) => [f.code, f]));
  const check = (code: string, type: FieldType, what: string) => {
    const f = byCode.get(code);
    if (!f) {
      if (complete) throw new Error(`${what} names unknown field "${code}".`);
      return;
    }
    if (f.type !== type) throw new Error(`${what} field "${code}" must be of type ${type}.`);
  };
  for (const [code, cfg] of Object.entries(ORDERED_LIST_CONFIG)) {
    check(code, FIELD_TYPES.ORDERED_LIST, "Ordered-list config");
    if (!Number.isInteger(cfg.rows) || cfg.rows < 1 || cfg.rows > MAX_ORDERED_ROWS) {
      throw new Error(`Ordered-list field "${code}" must have 1..${MAX_ORDERED_ROWS} rows.`);
    }
  }
  for (const [code, cfg] of Object.entries(NUMBER_FIELD_CONFIG)) {
    check(code, FIELD_TYPES.NUMBER, "Number config");
    if (!(cfg.min < cfg.max) || !Number.isInteger(cfg.decimals) || cfg.decimals < 0) {
      throw new Error(`Number field "${code}" has invalid bounds.`);
    }
  }
  for (const f of defs.fields) {
    if (f.type === FIELD_TYPES.ORDERED_LIST && !ORDERED_LIST_CONFIG[f.code]) {
      throw new Error(`Ordered-list field "${f.code}" has no ORDERED_LIST_CONFIG entry.`);
    }
    if (f.type === FIELD_TYPES.NUMBER && !NUMBER_FIELD_CONFIG[f.code]) {
      throw new Error(`Number field "${f.code}" has no NUMBER_FIELD_CONFIG entry.`);
    }
  }
  for (const rule of PATIENT_CONDITION_RULES) {
    if (complete && !byCode.has(rule.field)) {
      throw new Error(`Patient condition names unknown field "${rule.field}".`);
    }
  }
}

export const DEFAULT_CLINICAL_DEFINITIONS: ClinicalDefinitions = {
  fields: CLINICAL_FIELD_DEFINITIONS,
  sections: CLINICAL_SECTIONS,
};

assertDefinitionsConsistent(DEFAULT_CLINICAL_DEFINITIONS);
assertExclusionRulesConsistent(DEFAULT_CLINICAL_DEFINITIONS, FIELD_EXCLUSION_RULES);
assertFieldConfigConsistent(DEFAULT_CLINICAL_DEFINITIONS);
