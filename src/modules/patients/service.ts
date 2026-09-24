import { and, eq, ilike, inArray, or } from "drizzle-orm";
import type { Database } from "@/db/client";
import { patientExternalIds, patients } from "@/db/schema";
import { writeAudit } from "@/modules/audit/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { requirePermission } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { EXTERNAL_ID_SYSTEMS } from "./constants";
import type {
  CreatePatientInput,
  SearchPatientsInput,
  UpdatePatientInput,
} from "./schema";

export class DuplicateExternalIdError extends Error {
  constructor(system: string, value: string) {
    super(
      `A patient already exists with ${system} = "${value}". Duplicate external identifiers are not allowed.`,
    );
    this.name = "DuplicateExternalIdError";
  }
}

export interface PatientRecord {
  id: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  dateOfBirth: string | null;
  sex: string | null;
  phone: string | null;
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
  externalIds: { system: string; value: string }[];
}

async function loadExternalIds(db: Database, patientId: string) {
  return db
    .select({
      system: patientExternalIds.system,
      value: patientExternalIds.value,
    })
    .from(patientExternalIds)
    .where(eq(patientExternalIds.patientId, patientId));
}

export async function createPatient(
  db: Database,
  actor: ActorContext,
  input: CreatePatientInput,
): Promise<PatientRecord> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_CREATE, {
    entityType: "patient",
  });

  return db.transaction(async (tx) => {
    if (input.icareFileNo) {
      const [dup] = await tx
        .select({ id: patientExternalIds.id })
        .from(patientExternalIds)
        .where(
          and(
            eq(patientExternalIds.system, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO),
            eq(patientExternalIds.value, input.icareFileNo),
          ),
        )
        .limit(1);
      if (dup) {
        throw new DuplicateExternalIdError(
          EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO,
          input.icareFileNo,
        );
      }
    }

    const [created] = await tx
      .insert(patients)
      .values({
        firstName: input.firstName,
        lastName: input.lastName,
        middleName: input.middleName ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        sex: input.sex ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning();
    if (!created) throw new Error("Failed to create patient");

    let externalIds: { system: string; value: string }[] = [];
    if (input.icareFileNo) {
      await tx.insert(patientExternalIds).values({
        patientId: created.id,
        system: EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO,
        value: input.icareFileNo,
      });
      externalIds = [
        { system: EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO, value: input.icareFileNo },
      ];
    }

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "patient.create",
      entityType: "patient",
      entityId: created.id,
      patientId: created.id,
      after: { ...created, externalIds },
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });

    return {
      ...created,
      externalIds,
    };
  });
}

export async function updatePatient(
  db: Database,
  actor: ActorContext,
  input: UpdatePatientInput,
): Promise<PatientRecord> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_UPDATE, {
    entityType: "patient",
    entityId: input.id,
    patientId: input.id,
  });

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(patients)
      .where(eq(patients.id, input.id))
      .limit(1);
    if (!before) throw new Error("Patient not found");

    const [after] = await tx
      .update(patients)
      .set({
        firstName: input.firstName,
        lastName: input.lastName,
        middleName: input.middleName ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        sex: input.sex ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(patients.id, input.id))
      .returning();
    if (!after) throw new Error("Failed to update patient");

    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "patient.update",
      entityType: "patient",
      entityId: input.id,
      patientId: input.id,
      before,
      after,
      metadata: { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
    });

    const externalIds = await loadExternalIds(tx, input.id);
    return { ...after, externalIds };
  });
}

export async function getPatientById(
  db: Database,
  actor: ActorContext,
  id: string,
): Promise<PatientRecord | null> {
  await requirePermissionRead(db, actor, id);

  const [patient] = await db
    .select()
    .from(patients)
    .where(eq(patients.id, id))
    .limit(1);
  if (!patient) return null;

  const externalIds = await loadExternalIds(db, id);
  return { ...patient, externalIds };
}

export async function searchPatients(
  db: Database,
  actor: ActorContext,
  criteria: SearchPatientsInput,
): Promise<PatientRecord[]> {
  await requirePermissionRead(db, actor);

  const conditions = [];

  if (criteria.name) {
    const pattern = `%${criteria.name}%`;
    const nameCondition = or(
      ilike(patients.firstName, pattern),
      ilike(patients.lastName, pattern),
    );
    if (nameCondition) conditions.push(nameCondition);
  }
  if (criteria.phone) {
    conditions.push(ilike(patients.phone, `%${criteria.phone}%`));
  }
  if (criteria.dateOfBirth) {
    conditions.push(eq(patients.dateOfBirth, criteria.dateOfBirth));
  }

  if (criteria.externalId) {
    // Filter in SQL (before ORDER BY / LIMIT) so a matching file number is
    // never dropped because its patient falls outside the first page.
    conditions.push(
      inArray(
        patients.id,
        db
          .select({ patientId: patientExternalIds.patientId })
          .from(patientExternalIds)
          .where(ilike(patientExternalIds.value, `${criteria.externalId}%`)),
      ),
    );
  }

  const rows = await db
    .select()
    .from(patients)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(patients.lastName, patients.firstName)
    .limit(100);

  const results: PatientRecord[] = [];
  for (const row of rows) {
    const externalIds = await loadExternalIds(db, row.id);
    results.push({ ...row, externalIds });
  }
  return results;
}

async function requirePermissionRead(
  db: Database,
  actor: ActorContext,
  patientId?: string,
): Promise<void> {
  await requirePermission(db, actor, PERMISSIONS.PATIENT_READ, {
    entityType: "patient",
    entityId: patientId,
    patientId: patientId ?? null,
  });
}
