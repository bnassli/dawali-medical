"use server";

import { z } from "zod";
import { getDb } from "@/db/client";
import { getRequestMeta, requireActor } from "@/modules/auth/current-actor";
import { VisitNotFoundError, VisitNotOpenError } from "@/modules/clinical/service";
import { ForbiddenError } from "@/modules/permissions/service";
import {
  InvalidVisitStaffError,
  setVisitStaff,
  VisitStaffConflictError,
  type StaffMember,
} from "@/modules/visits/staff";

const inputSchema = z.object({
  visitId: z.string().uuid(),
  slot: z.enum(["doctor", "nurse"]),
  userId: z.string().uuid().nullable(),
  expectedUserId: z.string().uuid().nullable(),
});

export type SetVisitStaffResult =
  | { ok: true; member: StaffMember | null }
  | { ok: false; error: string; current?: StaffMember | null; conflict?: boolean };

export async function setVisitStaffAction(input: z.input<typeof inputSchema>): Promise<SetVisitStaffResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const actor = { ...(await requireActor()), ...(await getRequestMeta()) };
  try {
    return { ok: true, member: await setVisitStaff(getDb(), actor, parsed.data) };
  } catch (err) {
    if (err instanceof VisitStaffConflictError) {
      return { ok: false, error: err.message, current: err.current, conflict: true };
    }
    if (err instanceof ForbiddenError) return { ok: false, error: "You cannot change the visit's doctor or nurse." };
    if (
      err instanceof InvalidVisitStaffError ||
      err instanceof VisitNotOpenError ||
      err instanceof VisitNotFoundError
    ) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
