import { z } from "zod";
import { characterCount, MAX_FREE_TEXT_LENGTH } from "@/modules/clinical/schema";

export const createVisitSchema = z.object({
  patientId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .refine(
      (v) => characterCount(v) <= MAX_FREE_TEXT_LENGTH,
      `Reason for visit must be at most ${MAX_FREE_TEXT_LENGTH} characters.`,
    )
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
});

export type CreateVisitInput = z.infer<typeof createVisitSchema>;
