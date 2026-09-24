import { z } from "zod";

export const MAX_FREE_TEXT_LENGTH = 5000;
export const MAX_OPTION_LABEL_LENGTH = 200;

export const saveClinicalEntrySchema = z.object({
  visitId: z.string().uuid(),
  fieldId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).max(200),
  freeText: z.string().max(MAX_FREE_TEXT_LENGTH),
});

export const addClinicalOptionSchema = z.object({
  fieldId: z.string().uuid(),
  label: z.string().trim().min(1, "Option label is required").max(MAX_OPTION_LABEL_LENGTH),
});

export const setClinicalOptionActiveSchema = z.object({
  optionId: z.string().uuid(),
  isActive: z.boolean(),
});

export type SaveClinicalEntryInput = z.infer<typeof saveClinicalEntrySchema>;
export type AddClinicalOptionInput = z.infer<typeof addClinicalOptionSchema>;
export type SetClinicalOptionActiveInput = z.infer<typeof setClinicalOptionActiveSchema>;
