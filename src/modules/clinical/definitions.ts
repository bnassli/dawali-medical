export const FIELD_TYPES = {
  SELECT: "select",
  MULTISELECT: "multiselect",
  TEXT: "text",
  TEXTAREA: "textarea",
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
 * field/section codes, a section placing an unknown or duplicate field, or a
 * list on a text field.
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
  }
}

/**
 * Structural definitions only (fields, their type, section placement and
 * order). No clinical option VALUES are defined here — dropdown options are
 * data (CLAUDE.md rule #10), created through "+ Add New".
 *
 * Section order follows docs/CLINICAL_TABS.md "Subj Complaints Habits".
 * Field types are a best guess (no SonoSoft reference screens in the repo).
 * Because clinical entries may already exist, the seed NEVER changes an
 * existing field's type, option list or free-text flag: such a change needs a
 * migration (ADR-026). Labels and placement order may be updated here.
 */
export const SUBJ_COMPLAINTS_HABITS_SECTION_CODE = "subj_complaints_habits";

export const CLINICAL_FIELD_DEFINITIONS: FieldDefinitionSeed[] = [
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
];

export const CLINICAL_SECTIONS: SectionDefinitionSeed[] = [
  {
    code: SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    name: "Subj Complaints Habits",
    sortOrder: 1,
    fieldCodes: CLINICAL_FIELD_DEFINITIONS.map((f) => f.code),
  },
];

export const DEFAULT_CLINICAL_DEFINITIONS: ClinicalDefinitions = {
  fields: CLINICAL_FIELD_DEFINITIONS,
  sections: CLINICAL_SECTIONS,
};

assertDefinitionsConsistent(DEFAULT_CLINICAL_DEFINITIONS);
