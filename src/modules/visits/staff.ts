import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { roles, userRoles, users, visits } from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { VisitNotFoundError, VisitNotOpenError } from "@/modules/clinical/service";
import { PERMISSIONS, ROLES, type RoleCode } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";

/**
 * Doctor and nurse of a visit (ADR-039): each is an optional reference to a
 * user account with the matching role. Shown above the clinical tabs where
 * SonoSoft has "Interp Phys/Surgeon" and "Technologist".
 */
export const VISIT_STAFF_ROLE: Record<VisitStaffSlot, RoleCode> = {
  doctor: ROLES.DOCTOR,
  nurse: ROLES.NURSE_ASSISTANT,
};
export type VisitStaffSlot = "doctor" | "nurse";

export interface StaffMember {
  id: string;
  name: string;
}

export interface VisitStaff {
  doctor: StaffMember | null;
  nurse: StaffMember | null;
  /** Active users who can be chosen, by slot. */
  choices: Record<VisitStaffSlot, StaffMember[]>;
}

/** Someone else changed the slot after this page loaded: never last-write-wins. */
export class VisitStaffConflictError extends Error {
  constructor(readonly current: StaffMember | null) {
    super("Someone else changed this after you opened the visit. The current value is shown; choose again if needed.");
    this.name = "VisitStaffConflictError";
  }
}

export class InvalidVisitStaffError extends Error {
  constructor(slot: VisitStaffSlot) {
    super(`That person is not an active ${slot === "doctor" ? "doctor" : "nurse / assistant"}.`);
    this.name = "InvalidVisitStaffError";
  }
}

const COLUMN = { doctor: visits.doctorUserId, nurse: visits.nurseUserId } as const;

async function activeUsersWithRole(db: Database, role: RoleCode): Promise<StaffMember[]> {
  return db
    .selectDistinct({ id: users.id, name: users.displayName })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, role), eq(users.isActive, true)))
    .orderBy(asc(users.displayName));
}

async function memberById(db: Database, id: string | null): Promise<StaffMember | null> {
  if (!id) return null;
  const [row] = await db.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function getVisitStaff(db: Database, actor: ActorContext, visitId: string): Promise<VisitStaff> {
  await requirePermission(db, actor, PERMISSIONS.VISIT_READ, { entityType: "visit", visitId });
  const [visit] = await db
    .select({ doctorUserId: visits.doctorUserId, nurseUserId: visits.nurseUserId })
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  if (!visit) throw new VisitNotFoundError(visitId);
  const [doctor, nurse, doctors, nurses] = await Promise.all([
    memberById(db, visit.doctorUserId),
    memberById(db, visit.nurseUserId),
    activeUsersWithRole(db, VISIT_STAFF_ROLE.doctor),
    activeUsersWithRole(db, VISIT_STAFF_ROLE.nurse),
  ]);
  return { doctor, nurse, choices: { doctor: doctors, nurse: nurses } };
}

export interface SetVisitStaffInput {
  visitId: string;
  slot: VisitStaffSlot;
  /** null clears the slot. */
  userId: string | null;
  /** The value the page showed; the change is refused if it no longer matches. */
  expectedUserId: string | null;
}

/**
 * Sets the doctor or nurse of an open visit. Same rules as clinical entries:
 * clinical.write, open visit only, optimistic check against the value the
 * page showed, audited (`visit.staff`) with before/after.
 */
export async function setVisitStaff(
  db: Database,
  actor: ActorContext,
  input: SetVisitStaffInput,
): Promise<StaffMember | null> {
  await requirePermission(db, actor, PERMISSIONS.CLINICAL_WRITE, { entityType: "visit", visitId: input.visitId });

  return db.transaction(async (tx) => {
    const [visit] = await tx
      .select({ id: visits.id, patientId: visits.patientId, status: visits.status, current: COLUMN[input.slot] })
      .from(visits)
      .where(eq(visits.id, input.visitId))
      .limit(1)
      .for("update");
    if (!visit) throw new VisitNotFoundError(input.visitId);
    if (visit.status !== "open") throw new VisitNotOpenError(visit.id, visit.status);

    if (visit.current !== input.expectedUserId) {
      throw new VisitStaffConflictError(await memberById(tx, visit.current));
    }
    if (visit.current === input.userId) return memberById(tx, visit.current);

    let chosen: StaffMember | null = null;
    if (input.userId) {
      const allowed = await activeUsersWithRole(tx, VISIT_STAFF_ROLE[input.slot]);
      chosen = allowed.find((m) => m.id === input.userId) ?? null;
      if (!chosen) throw new InvalidVisitStaffError(input.slot);
    }

    await tx
      .update(visits)
      .set(input.slot === "doctor" ? { doctorUserId: input.userId, updatedAt: new Date() } : { nurseUserId: input.userId, updatedAt: new Date() })
      .where(eq(visits.id, visit.id));

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "visit.staff",
      entityType: "visit",
      entityId: visit.id,
      patientId: visit.patientId,
      visitId: visit.id,
      before: { slot: input.slot, userId: visit.current },
      after: { slot: input.slot, userId: input.userId },
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });

    return chosen;
  });
}
