import { z } from "zod";
import { DEMOGRAPHIC_LIST_CODES, SEX_VALUES } from "./constants";

/**
 * zod infers `key: T | undefined` for optional-with-transform fields; this makes
 * such keys optional so callers may simply omit fields they do not set.
 */
type UndefinedToOptional<T> = {
  [K in keyof T as undefined extends T[K] ? K : never]?: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};

/** Max length of any single demographic text value. */
export const MAX_DEMOGRAPHIC_TEXT_LENGTH = 200;

const dateOnly = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const optionalTrimmed = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === "" ? undefined : v));

/** Optional trimmed text with the demographic length limit. */
const optionalText = (label: string) =>
  z
    .string()
    .trim()
    .max(MAX_DEMOGRAPHIC_TEXT_LENGTH, `${label} must be at most ${MAX_DEMOGRAPHIC_TEXT_LENGTH} characters`)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const optionalDate = () =>
  z
    .union([dateOnly, z.literal("")])
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const optionalSex = () =>
  z
    .union([z.enum(SEX_VALUES), z.literal("")], { error: "Sex must be Female, Male or blank" })
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const optionalOptionId = () =>
  z
    .union([z.string().uuid(), z.literal("")], { error: "Invalid option" })
    .optional()
    .transform((v) => (v === "" ? undefined : v));

/** Fields shared by create and update (V1 form, ADR-028). */
const patientFields = {
  firstName: z.string().trim().min(1, "First name is required").max(MAX_DEMOGRAPHIC_TEXT_LENGTH),
  lastName: z.string().trim().min(1, "Last name is required").max(MAX_DEMOGRAPHIC_TEXT_LENGTH),
  middleName: optionalTrimmed(),
  dateOfBirth: optionalDate(),
  sex: optionalSex(),
  phone: optionalTrimmed(),
  email: optionalTrimmed(),
  /** File / Medical ID shown to users = the iCare file number (ADR-028). */
  icareFileNo: optionalText("File / Medical ID"),
  nationalityOptionId: optionalOptionId(),
  preferredLanguageOptionId: optionalOptionId(),
  nationalId: optionalText("National ID / Iqama"),
  insuranceId: optionalText("Insurance ID"),
  emergencyContactName: optionalText("Emergency contact name"),
  emergencyContactPhone: optionalText("Emergency contact phone"),
  emergencyContactRelationship: optionalText("Emergency contact relationship"),
};

export const createPatientSchema = z.object(patientFields);

export type CreatePatientInput = UndefinedToOptional<z.infer<typeof createPatientSchema>>;

export const updatePatientSchema = z.object({
  id: z.string().uuid(),
  /** The patients.version the edit was based on (optimistic concurrency). */
  expectedVersion: z.coerce.number().int().min(1),
  ...patientFields,
});

export type UpdatePatientInput = UndefinedToOptional<z.infer<typeof updatePatientSchema>>;

export const setPatientActiveSchema = z.object({
  id: z.string().uuid(),
  isActive: z.boolean(),
  expectedVersion: z.coerce.number().int().min(1),
});

export type SetPatientActiveInput = z.infer<typeof setPatientActiveSchema>;

export const searchPatientsSchema = z
  .object({
    /** Matches first OR last name (contains). */
    name: optionalTrimmed(),
    firstName: optionalTrimmed(),
    lastName: optionalTrimmed(),
    /** File / Medical ID = iCare file number (prefix). */
    externalId: optionalTrimmed(),
    insuranceId: optionalTrimmed(),
    phone: optionalTrimmed(),
    dateOfBirth: optionalDate(),
    includeInactive: z.boolean().optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.name ??
          v.firstName ??
          v.lastName ??
          v.externalId ??
          v.insuranceId ??
          v.phone ??
          v.dateOfBirth,
      ),
    "Provide at least one search criterion",
  );

export type SearchPatientsInput = UndefinedToOptional<z.infer<typeof searchPatientsSchema>>;

export const addDemographicOptionSchema = z.object({
  listCode: z.enum(DEMOGRAPHIC_LIST_CODES),
  label: z
    .string()
    .trim()
    .min(1, "Option label is required")
    .max(MAX_DEMOGRAPHIC_TEXT_LENGTH),
});

export type AddDemographicOptionInput = z.infer<typeof addDemographicOptionSchema>;

export const setDemographicOptionActiveSchema = z.object({
  optionId: z.string().uuid(),
  isActive: z.boolean(),
});

export type SetDemographicOptionActiveInput = z.infer<typeof setDemographicOptionActiveSchema>;
