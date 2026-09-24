import { z } from "zod";
import { ROLES } from "@/modules/permissions/constants";

const roleCodeSchema = z.enum([
  ROLES.ADMIN,
  ROLES.DOCTOR,
  ROLES.NURSE_ASSISTANT,
  ROLES.RECEPTION,
  ROLES.INVENTORY,
]);

export const createUserSchema = z.object({
  email: z.string().trim().min(1).email(),
  displayName: z.string().trim().min(1, "Display name is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  roleCodes: z.array(roleCodeSchema).min(1, "At least one role is required"),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const setUserActiveSchema = z.object({
  userId: z.string().uuid(),
  isActive: z.boolean(),
});

export type SetUserActiveInput = z.infer<typeof setUserActiveSchema>;
