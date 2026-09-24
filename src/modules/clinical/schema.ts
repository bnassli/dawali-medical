import { z } from "zod";

export const MAX_FREE_TEXT_LENGTH = 5000;
export const MAX_OPTION_LABEL_LENGTH = 200;

/** Fields the client supplies in the request body. patientId is never accepted:
 * it is always derived server-side from the visit. */
export const saveClinicalEntryBodySchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    clientMutationId: z.string().uuid(),
    optionIds: z.array(z.string().uuid()).max(200),
    freeText: z.string().max(MAX_FREE_TEXT_LENGTH),
  })
  .strict();

export const saveClinicalEntrySchema = saveClinicalEntryBodySchema.extend({
  visitId: z.string().uuid(),
  fieldId: z.string().uuid(),
});

export const addClinicalOptionBodySchema = z
  .object({
    label: z.string().trim().min(1, "Option label is required").max(MAX_OPTION_LABEL_LENGTH),
  })
  .strict();

export const addClinicalOptionSchema = addClinicalOptionBodySchema.extend({
  fieldId: z.string().uuid(),
});

export const setClinicalOptionActiveSchema = z.object({
  optionId: z.string().uuid(),
  isActive: z.boolean(),
});

export type SaveClinicalEntryInput = z.infer<typeof saveClinicalEntrySchema>;
export type AddClinicalOptionInput = z.infer<typeof addClinicalOptionSchema>;
export type SetClinicalOptionActiveInput = z.infer<typeof setClinicalOptionActiveSchema>;
