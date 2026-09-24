import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { patients, visits } from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { recordInitialReasonForVisit } from "@/modules/clinical/service";
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
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Explicit column list: the deprecated legacy visits.reason column is never
 * selected (ADR-024). Reason for Visit is read from clinical_entries only.
 */
const visitColumns = {
  id: visits.id,
  patientId: visits.patientId,
  visitDate: visits.visitDate,
  status: visits.status,
  createdAt: visits.createdAt,
  updatedAt: visits.updatedAt,
};

export async function createVisit(
  db: Database,
  actor: ActorContext,
  input: CreateVisitInput,
): Promise<VisitRecord> {
  await requirePermission(db, actor, PERMISSIONS.VISIT_CREATE, {
    entityType: "visit",
    patientId: input.patientId,
  });

  return db.transaction(async (tx) => {
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
        createdBy: actor.userId,
      })
      .returning(visitColumns);
    if (!created) throw new Error("Failed to create visit");

    // The reason typed at intake is stored ONLY as a reason_for_visit
    // clinical entry (ADR-024), in this same transaction.
    if (input.reason) {
      await recordInitialReasonForVisit(tx, actor, created, input.reason);
    }

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
    .select(visitColumns)
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
    .select(visitColumns)
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
  await requirePermission(db, actor, PERMISSIONS.VISIT_READ, {
    entityType: "visit",
    patientId: patientId ?? null,
  });
}
