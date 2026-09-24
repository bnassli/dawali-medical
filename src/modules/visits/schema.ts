import { z } from "zod";

export const createVisitSchema = z.object({
  patientId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
});

export type CreateVisitInput = z.infer<typeof createVisitSchema>;
