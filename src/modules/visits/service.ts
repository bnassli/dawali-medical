import { and, desc, eq } from "drizzle-orm";
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

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used for a different visit request.");
    this.name = "IdempotencyKeyConflictError";
  }
}

export interface VisitRecord {
  id: string;
  idempotencyKey: string;
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
        idempotencyKey: input.idempotencyKey,
        patientId: input.patientId,
        reason: input.reason ?? null,
        createdBy: actor.userId,
      })
      .onConflictDoNothing({ target: visits.idempotencyKey })
      .returning();
    if (!created) {
      const [existing] = await tx
        .select()
        .from(visits)
        .where(eq(visits.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (!existing) throw new Error("Failed to create or recover visit");
      if (
        existing.patientId !== input.patientId ||
        existing.reason !== (input.reason ?? null)
      ) {
        throw new IdempotencyKeyConflictError();
      }
      return existing;
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
    .select()
    .from(visits)
    .where(eq(visits.patientId, patientId))
    .orderBy(desc(visits.visitDate));
}

export async function getVisitById(
  db: Database,
  actor: ActorContext,
  patientId: string,
  visitId: string,
): Promise<VisitRecord | null> {
  await requireVisitRead(db, actor, patientId);

  const [visit] = await db
    .select()
    .from(visits)
    .where(and(eq(visits.id, visitId), eq(visits.patientId, patientId)))
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
