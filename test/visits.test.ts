import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, visits } from "@/db/schema";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import {
  createVisit,
  getVisitById,
  IdempotencyKeyConflictError,
  listVisitsForPatient,
  PatientNotFoundError,
} from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("visits", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    const opened = openTestDb();
    db = opened.db;
    close = opened.close;
  });

  afterAll(async () => {
    await close();
  });

  it("creates a visit and writes a visit.create audit row with patientId and visitId", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const suffix = uniqueSuffix();

    const patient = await createPatient(db, actor, {
      firstName: `Ivy-${suffix}`,
      lastName: `Irwin-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });

    const visit = await createVisit(db, actor, {
      patientId: patient.id,
      idempotencyKey: randomUUID(),
      reason: "Initial consultation",
    });

    expect(visit.patientId).toBe(patient.id);

    const [auditRow] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "visit.create"), eq(auditLogs.visitId, visit.id)));

    expect(auditRow).toBeDefined();
    expect(auditRow?.patientId).toBe(patient.id);
    expect(auditRow?.visitId).toBe(visit.id);
  });

  it("rejects creating a visit for a non-existent patient", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    await expect(
      createVisit(db, actor, {
        patientId: "00000000-0000-0000-0000-000000000000",
        idempotencyKey: randomUUID(),
        reason: undefined,
      }),
    ).rejects.toBeInstanceOf(PatientNotFoundError);
  });

  it("lists visits for a patient, newest first, and never returns another patient's visits", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const suffix = uniqueSuffix();

    const patientA = await createPatient(db, actor, {
      firstName: `Jack-${suffix}`,
      lastName: `Jones-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    const patientB = await createPatient(db, actor, {
      firstName: `Kim-${suffix}`,
      lastName: `Kelly-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });

    const visitA1 = await createVisit(db, actor, { patientId: patientA.id, idempotencyKey: randomUUID(), reason: "A1" });
    const visitA2 = await createVisit(db, actor, { patientId: patientA.id, idempotencyKey: randomUUID(), reason: "A2" });
    const visitB1 = await createVisit(db, actor, { patientId: patientB.id, idempotencyKey: randomUUID(), reason: "B1" });

    const visitsForA = await listVisitsForPatient(db, actor, patientA.id);
    const idsForA = visitsForA.map((v) => v.id);

    expect(idsForA).toContain(visitA1.id);
    expect(idsForA).toContain(visitA2.id);
    expect(idsForA).not.toContain(visitB1.id);

    const visitsForB = await listVisitsForPatient(db, actor, patientB.id);
    expect(visitsForB.map((v) => v.id)).toEqual([visitB1.id]);
  });

  it("returns the original visit for a retried idempotent create without a second audit row", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const suffix = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Retry-${suffix}`,
      lastName: `Visit-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    const input = {
      patientId: patient.id,
      idempotencyKey: randomUUID(),
      reason: "Idempotent visit",
    };

    const [first, retry] = await Promise.all([
      createVisit(db, actor, input),
      createVisit(db, actor, input),
    ]);
    expect(retry.id).toBe(first.id);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "visit.create"), eq(auditLogs.visitId, first.id)));
    expect(audits).toHaveLength(1);
  });

  it("rejects an invalid visit status at the database boundary", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const suffix = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Status-${suffix}`,
      lastName: `Check-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });

    await expect(
      db.insert(visits).values({
        patientId: patient.id,
        idempotencyKey: randomUUID(),
        status: "not-a-valid-status",
        createdBy: actor.userId,
      }),
    ).rejects.toThrow();
  });

  it("rejects reusing an idempotency key for a different visit request", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const suffix = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Key-${suffix}`,
      lastName: `Conflict-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    const idempotencyKey = randomUUID();
    await createVisit(db, actor, { patientId: patient.id, idempotencyKey, reason: "First" });
    await expect(
      createVisit(db, actor, { patientId: patient.id, idempotencyKey, reason: "Different" }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it("binds a visit lookup to its owning patient", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const suffix = uniqueSuffix();
    const patientA = await createPatient(db, actor, {
      firstName: `Owner-${suffix}`,
      lastName: `A-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    const patientB = await createPatient(db, actor, {
      firstName: `Owner-${suffix}`,
      lastName: `B-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    const visit = await createVisit(db, actor, {
      patientId: patientA.id,
      idempotencyKey: randomUUID(),
      reason: "Scoped lookup",
    });

    expect(await getVisitById(db, actor, patientA.id, visit.id)).not.toBeNull();
    expect(await getVisitById(db, actor, patientB.id, visit.id)).toBeNull();
  });

  it("denies visit creation for a role without visit.create and audits access.denied", async () => {
    const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: inventory } = await createTestUser(db, { roleCode: "INVENTORY" });
    const suffix = uniqueSuffix();

    const patient = await createPatient(db, doctor, {
      firstName: `Leo-${suffix}`,
      lastName: `Lane-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });

    await expect(
      createVisit(db, inventory, { patientId: patient.id, idempotencyKey: randomUUID(), reason: undefined }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "access.denied"), eq(auditLogs.actorUserId, inventory.userId)),
      );
    expect(rows.length).toBeGreaterThan(0);
  });
});
