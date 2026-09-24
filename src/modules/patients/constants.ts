/**
 * Known external identifier "systems". iCare is the first external system
 * we integrate with; the column stays generic text so future systems don't
 * require a migration (ICARE_INTEGRATION.md).
 *
 * ICARE_FILE_NO is the File / Medical ID shown to users (ADR-028); there is no
 * second, competing clinic file number. NATIONAL_ID is the National ID / Iqama.
 * At most one value per system per patient; values are unique per system.
 */
export const EXTERNAL_ID_SYSTEMS = {
  ICARE_FILE_NO: "ICARE_FILE_NO",
  NATIONAL_ID: "NATIONAL_ID",
} as const;

export type ExternalIdSystem = (typeof EXTERNAL_ID_SYSTEMS)[keyof typeof EXTERNAL_ID_SYSTEMS];

/**
 * Patient sex codes (ADR-028). A small fixed demographic code set (the
 * Female-specific Past Medical Hx rule depends on it), enforced by the
 * patients_sex_check constraint; NULL = blank/unknown.
 */
export const SEX_VALUES = ["F", "M"] as const;
export type Sex = (typeof SEX_VALUES)[number];

export const SEX_LABELS: Record<Sex, string> = {
  F: "Female",
  M: "Male",
};

/**
 * Configurable demographic option lists (ADR-028). The list codes are
 * structural (demographic_options_list_code_check); their values are data.
 */
export const DEMOGRAPHIC_LIST_CODES = ["nationality", "preferred_language"] as const;
export type DemographicListCode = (typeof DEMOGRAPHIC_LIST_CODES)[number];

export const DEMOGRAPHIC_LIST_NAMES: Record<DemographicListCode, string> = {
  nationality: "Nationality",
  preferred_language: "Preferred Language",
};

/**
 * Initial values seeded once (Product Owner decision, ADR-028). The seed only
 * inserts missing ones and never reactivates a retired one.
 */
export const DEFAULT_DEMOGRAPHIC_OPTIONS: Record<DemographicListCode, string[]> = {
  nationality: [],
  preferred_language: ["Arabic", "English"],
};
