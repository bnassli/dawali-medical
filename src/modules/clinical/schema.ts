import { z } from "zod";

/**
 * Maximum length of any free text (clinical free text and the intake Reason for
 * Visit), counted in characters = Unicode code points. Counted explicitly (not
 * by String.length, which counts UTF-16 units) so TypeScript, the schemas and
 * migration 0004 (PostgreSQL char_length) all use the same rule. The HTML
 * maxLength attribute counts UTF-16 units, so for text with astral characters
 * (emoji) the browser is stricter than the server, never looser.
 */
export const MAX_FREE_TEXT_LENGTH = 5000;

export function characterCount(value: string): number {
  return Array.from(value).length;
}

export const freeTextTooLongMessage = `Text must be at most ${MAX_FREE_TEXT_LENGTH} characters.`;
export const MAX_OPTION_LABEL_LENGTH = 200;

/**
 * Fields the client supplies in the request body. patientId is never accepted:
 * it is always derived server-side from the visit. expectedUserId is the user
 * the page was rendered for; the request is refused if the session now belongs
 * to somebody else (ADR-023), so text typed as user A is never saved as user B.
 */
export const saveClinicalEntryBodySchema = z
  .object({
    expectedUserId: z.string().uuid(),
    expectedVersion: z.number().int().min(0),
    clientMutationId: z.string().uuid(),
    optionIds: z.array(z.string().uuid()).max(200),
    freeText: z
      .string()
      .refine((v) => characterCount(v) <= MAX_FREE_TEXT_LENGTH, freeTextTooLongMessage),
  })
  .strict();

export const saveClinicalEntrySchema = saveClinicalEntryBodySchema
  .omit({ expectedUserId: true })
  .extend({
    visitId: z.string().uuid(),
    fieldId: z.string().uuid(),
  });

export const addClinicalOptionBodySchema = z
  .object({
    expectedUserId: z.string().uuid(),
    label: z.string().trim().min(1, "Option label is required").max(MAX_OPTION_LABEL_LENGTH),
  })
  .strict();

export const addClinicalOptionSchema = addClinicalOptionBodySchema
  .omit({ expectedUserId: true })
  .extend({
    fieldId: z.string().uuid(),
  });

export const setClinicalOptionActiveSchema = z.object({
  optionId: z.string().uuid(),
  isActive: z.boolean(),
});

export type SaveClinicalEntryInput = z.infer<typeof saveClinicalEntrySchema>;
export type AddClinicalOptionInput = z.infer<typeof addClinicalOptionSchema>;
export type SetClinicalOptionActiveInput = z.infer<typeof setClinicalOptionActiveSchema>;
