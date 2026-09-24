import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { patients, visits } from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import type { CreateVisitInput } from "./schema";

export class PatientNotFoundError extends Error {
  constructor(patientId: string) {
    super(`Patient ${patientId} does not exist.`);
    this.name = "PatientNotFoundError";
  }
}

export interface VisitRecord {
  id: string;
  patientId: string;
  visitDate: Date;
  reason: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function createVisit(
  db: Database,
  actor: ActorContext,
  input: CreateVisitInput,
): Promise<VisitRecord> {
  return db.transaction(async (tx) => {
    await requirePermission(tx, actor, PERMISSIONS.VISIT_CREATE, {
      entityType: "visit",
      patientId: input.patientId,
    });

    // Visits must reference an existing patient (CLAUDE.md rule #6: Patient
    // and Visit remain separate entities, but a visit is never orphaned).
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.id, input.patientId))
      .limit(1);
    if (!patient) {
      throw new PatientNotFoundError(input.patientId);
    }

    const [created] = await tx
      .insert(visits)
      .values({
        patientId: input.patientId,
        reason: input.reason ?? null,
        createdBy: actor.userId,
      })
      .returning();
    if (!created) throw new Error("Failed to create visit");

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "visit.create",
      entityType: "visit",
      entityId: created.id,
      patientId: created.patientId,
      visitId: created.id,
      after: created,
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });

    return created;
  });
}

export async function listVisitsForPatient(
  db: Database,
  actor: ActorContext,
  patientId: string,
): Promise<VisitRecord[]> {
  await requireVisitRead(db, actor, patientId);

  return db
    .select()
    .from(visits)
    .where(eq(visits.patientId, patientId))
    .orderBy(desc(visits.visitDate));
}

export async function getVisitById(
  db: Database,
  actor: ActorContext,
  visitId: string,
): Promise<VisitRecord | null> {
  await requireVisitRead(db, actor);

  const [visit] = await db
    .select()
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  return visit ?? null;
}

async function requireVisitRead(
  db: Database,
  actor: ActorContext,
  patientId?: string,
): Promise<void> {
  if (actor.permissions.has(PERMISSIONS.VISIT_READ)) return;
  await db.transaction(async (tx) => {
    await requirePermission(tx, actor, PERMISSIONS.VISIT_READ, {
      entityType: "visit",
      patientId: patientId ?? null,
    });
  });
}
