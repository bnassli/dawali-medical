/** Field names of the V1 Create/Edit Patient form, in display order (FINAL_V1 §5). */
export const PATIENT_FORM_FIELDS = [
  "icareFileNo",
  "firstName",
  "middleName",
  "lastName",
  "sex",
  "dateOfBirth",
  "phone",
  "email",
  "nationalityOptionId",
  "preferredLanguageOptionId",
  "nationalId",
  "insuranceId",
  "emergencyContactName",
  "emergencyContactPhone",
  "emergencyContactRelationship",
] as const;

export type PatientFormField = (typeof PATIENT_FORM_FIELDS)[number];

export type PatientFormValues = Partial<Record<PatientFormField, string>>;

export interface PatientFormState {
  error: string | null;
  /** The submitted values, returned on error so nothing typed is lost. */
  values: Record<string, string> | null;
}

export const INITIAL_PATIENT_FORM_STATE: PatientFormState = { error: null, values: null };

/** One row of the Patient Search results table (only what the table shows). */
export interface PatientSearchRow {
  id: string;
  fileId: string | null;
  lastName: string;
  firstName: string;
  middleName: string | null;
  dateOfBirth: string | null;
  isActive: boolean;
}

export type PatientSearchResult =
  | { ok: true; rows: PatientSearchRow[] }
  | { ok: false; error: string };

export interface DemographicOptionLists {
  nationality: { id: string; label: string; isActive: boolean }[];
  preferred_language: { id: string; label: string; isActive: boolean }[];
}
