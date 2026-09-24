import { z } from "zod";

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

export const createPatientSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  middleName: optionalTrimmed(),
  dateOfBirth: z
    .union([dateOnly, z.literal("")])
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  sex: optionalTrimmed(),
  phone: optionalTrimmed(),
  email: optionalTrimmed(),
  icareFileNo: optionalTrimmed(),
});

export type CreatePatientInput = z.infer<typeof createPatientSchema>;

export const updatePatientSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  middleName: optionalTrimmed(),
  dateOfBirth: z
    .union([dateOnly, z.literal("")])
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  sex: optionalTrimmed(),
  phone: optionalTrimmed(),
  email: optionalTrimmed(),
});

export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;

export const searchPatientsSchema = z
  .object({
    name: optionalTrimmed(),
    externalId: optionalTrimmed(),
    phone: optionalTrimmed(),
    dateOfBirth: z
      .union([dateOnly, z.literal("")])
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
  })
  .refine(
    (v) => Boolean(v.name ?? v.externalId ?? v.phone ?? v.dateOfBirth),
    "Provide at least one search criterion",
  );

export type SearchPatientsInput = z.infer<typeof searchPatientsSchema>;
