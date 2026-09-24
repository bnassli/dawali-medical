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

export interface FieldDefinitionSeed {
  code: string;
  label: string;
  type: FieldType;
}

export interface SectionDefinitionSeed {
  code: string;
  name: string;
  sortOrder: number;
  fields: FieldDefinitionSeed[];
}

/**
 * Structural definitions only (sections, fields, their order and type).
 * No clinical option VALUES are defined here — dropdown options are data
 * (CLAUDE.md rule #10), created through "+ Add New".
 *
 * Field order follows docs/CLINICAL_TABS.md "Subj Complaints Habits".
 * Field types are a best-guess (no SonoSoft reference screens in the repo)
 * and are adjustable by editing this list and re-running `npm run db:seed`.
 */
export const SUBJ_COMPLAINTS_HABITS_SECTION_CODE = "subj_complaints_habits";

export const CLINICAL_SECTIONS: SectionDefinitionSeed[] = [
  {
    code: SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    name: "Subj Complaints Habits",
    sortOrder: 1,
    fields: [
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
    ],
  },
];

export function optionListCode(sectionCode: string, fieldCode: string): string {
  return `${sectionCode}.${fieldCode}`;
}
