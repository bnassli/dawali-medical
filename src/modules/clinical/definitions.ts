export const FIELD_TYPES = {
  SELECT: "select",
  MULTISELECT: "multiselect",
  TEXT: "text",
  TEXTAREA: "textarea",
  /** Boolean flag stored as `checked` in the entry value (ADR-027). */
  CHECKBOX: "checkbox",
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
 * Section and field order follow docs/CLINICAL_TABS.md. Field types are a best
 * guess (no SonoSoft reference screens in the repo). Field CODES are durable
 * (reports and later tabs bind to them; see ADR-027 and PROMPT_SPRINT_3A.md).
 * Because clinical entries may already exist, the seed NEVER changes an
 * existing field's type, option list or free-text flag: such a change needs a
 * migration (ADR-026). Labels and placement order may be updated here.
 */
export const SUBJ_COMPLAINTS_HABITS_SECTION_CODE = "subj_complaints_habits";
export const PAST_MEDICAL_HX_SECTION_CODE = "past_medical_hx";
export const ASSESSMENT_PLAN_SECTION_CODE = "assessment_plan";

export const CLINICAL_FIELD_DEFINITIONS: FieldDefinitionSeed[] = [
  // --- Subj Complaints Habits (Sprint 2) ---
  { code: "reason_for_visit", label: "Reason for Visit", type: FIELD_TYPES.SELECT },
  { code: "problem_list", label: "Problem List", type: FIELD_TYPES.MULTISELECT },
  { code: "chief_complaints", label: "Chief Complaints", type: FIELD_TYPES.MULTISELECT },
  { code: "characteristics", label: "Characteristics", type: FIELD_TYPES.MULTISELECT },
  { code: "duration", label: "Duration", type: FIELD_TYPES.SELECT },
  { code: "progression", label: "Progression", type: FIELD_TYPES.SELECT },
  { code: "daily_activity_impact", label: "Daily Activity Impact", type: FIELD_TYPES.SELECT },
  { code: "chest_comments", label: "Chest Comments", type: FIELD_TYPES.TEXTAREA },
  { code: "comments", label: "Comments", type: FIELD_TYPES.TEXTAREA },
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
  { code: "pain_meds", label: "Pain Meds", type: FIELD_TYPES.MULTISELECT },
  { code: "current_meds", label: "Current Meds", type: FIELD_TYPES.MULTISELECT },
  { code: "allergies", label: "Allergies", type: FIELD_TYPES.MULTISELECT },

  // --- Past Medical Hx (Sprint 3A). "Family Medical Hx" is NOT defined here: it
  // is the existing global `family_history`, placed in this tab (one source). ---
  { code: "past_medical_history", label: "Past Medical Hx", type: FIELD_TYPES.MULTISELECT },
  { code: "past_medical_unknown", label: "Unknown", type: FIELD_TYPES.CHECKBOX },
  { code: "prior_test_results", label: "Prior Test Results", type: FIELD_TYPES.TEXTAREA },
  {
    code: "past_medical_additional_comments",
    label: "Additional Comments",
    type: FIELD_TYPES.TEXTAREA,
  },
  { code: "surgical_history", label: "Surgical Hx", type: FIELD_TYPES.MULTISELECT },

  // --- Assessment Plan+ (Sprint 3A) ---
  { code: "impression", label: "Impression", type: FIELD_TYPES.MULTISELECT },
  { code: "recommendations", label: "Recommendations", type: FIELD_TYPES.MULTISELECT },
  { code: "stockings_type", label: "Stockings Type", type: FIELD_TYPES.SELECT },
  { code: "stockings_compression", label: "Stockings Compression", type: FIELD_TYPES.SELECT },
  { code: "stockings_gender", label: "Stockings Gender", type: FIELD_TYPES.SELECT },
  { code: "stockings_color", label: "Stockings Color", type: FIELD_TYPES.SELECT },
  { code: "stockings_measurements", label: "Stockings Measurements", type: FIELD_TYPES.TEXTAREA },
  {
    code: "assessment_additional_comments",
    label: "Additional Comments",
    type: FIELD_TYPES.TEXTAREA,
  },
];

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
  "progression",
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

/** docs/CLINICAL_TABS.md order; the female-specific field is deferred (ADR-027). */
export const PAST_MEDICAL_HX_FIELD_CODES = [
  "past_medical_history",
  "family_history",
  "past_medical_unknown",
  "prior_test_results",
  "past_medical_additional_comments",
  "surgical_history",
];

/** Impression -> Recommendations -> Stockings detail -> Additional Comments. */
export const ASSESSMENT_PLAN_FIELD_CODES = [
  "impression",
  "recommendations",
  "stockings_type",
  "stockings_compression",
  "stockings_gender",
  "stockings_color",
  "stockings_measurements",
  "assessment_additional_comments",
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
];

/** "Unknown" past medical history cannot coexist with Past Medical Hx values. */
export const FIELD_EXCLUSION_RULES: ExclusionRule[] = [
  { flag: "past_medical_unknown", excludes: ["past_medical_history"] },
];

export const DEFAULT_CLINICAL_DEFINITIONS: ClinicalDefinitions = {
  fields: CLINICAL_FIELD_DEFINITIONS,
  sections: CLINICAL_SECTIONS,
};

assertDefinitionsConsistent(DEFAULT_CLINICAL_DEFINITIONS);
assertExclusionRulesConsistent(DEFAULT_CLINICAL_DEFINITIONS, FIELD_EXCLUSION_RULES);
