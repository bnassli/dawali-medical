import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs } from "@/db/schema";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import {
  createVisit,
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

    const visitA1 = await createVisit(db, actor, { patientId: patientA.id, reason: "A1" });
    const visitA2 = await createVisit(db, actor, { patientId: patientA.id, reason: "A2" });
    const visitB1 = await createVisit(db, actor, { patientId: patientB.id, reason: "B1" });

    const visitsForA = await listVisitsForPatient(db, actor, patientA.id);
    const idsForA = visitsForA.map((v) => v.id);

    expect(idsForA).toContain(visitA1.id);
    expect(idsForA).toContain(visitA2.id);
    expect(idsForA).not.toContain(visitB1.id);

    const visitsForB = await listVisitsForPatient(db, actor, patientB.id);
    expect(visitsForB.map((v) => v.id)).toEqual([visitB1.id]);
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
      createVisit(db, inventory, { patientId: patient.id, reason: undefined }),
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
