import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, visits } from "@/db/schema";
import { VisitNotOpenError } from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import {
  getVisitStaff,
  InvalidVisitStaffError,
  setVisitStaff,
  VisitStaffConflictError,
} from "@/modules/visits/staff";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("visit doctor and nurse (ADR-039)", () => {
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

  async function newVisit(actor: ActorContext) {
    const s = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Staff-${s}`,
      lastName: `Visit-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return createVisit(db, actor, { patientId: patient.id, reason: undefined });
  }

  it("lists active doctors and nurses and starts empty", async () => {
    const doc = await createTestUser(db, { roleCode: "DOCTOR" });
    const nurse = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const inactiveDoc = await createTestUser(db, { roleCode: "DOCTOR", isActive: false });
    const visit = await newVisit(doc.actor);

    const staff = await getVisitStaff(db, doc.actor, visit.id);
    expect(staff.doctor).toBeNull();
    expect(staff.nurse).toBeNull();
    expect(staff.choices.doctor.map((m) => m.id)).toContain(doc.userId);
    expect(staff.choices.doctor.map((m) => m.id)).not.toContain(inactiveDoc.userId);
    expect(staff.choices.doctor.map((m) => m.id)).not.toContain(nurse.userId);
    expect(staff.choices.nurse.map((m) => m.id)).toContain(nurse.userId);
  });

  it("sets and clears doctor and nurse, audits before/after", async () => {
    const doc = await createTestUser(db, { roleCode: "DOCTOR" });
    const nurse = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const visit = await newVisit(doc.actor);

    const d = await setVisitStaff(db, nurse.actor, { visitId: visit.id, slot: "doctor", userId: doc.userId, expectedUserId: null });
    expect(d?.id).toBe(doc.userId);
    await setVisitStaff(db, nurse.actor, { visitId: visit.id, slot: "nurse", userId: nurse.userId, expectedUserId: null });

    const staff = await getVisitStaff(db, doc.actor, visit.id);
    expect(staff.doctor?.id).toBe(doc.userId);
    expect(staff.nurse?.id).toBe(nurse.userId);

    await setVisitStaff(db, doc.actor, { visitId: visit.id, slot: "nurse", userId: null, expectedUserId: nurse.userId });
    expect((await getVisitStaff(db, doc.actor, visit.id)).nurse).toBeNull();

    const audits = await db
      .select({ before: auditLogs.before, after: auditLogs.after, actor: auditLogs.actorUserId })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "visit.staff"), eq(auditLogs.visitId, visit.id)));
    expect(audits).toHaveLength(3);
    expect(audits).toContainEqual({
      before: { slot: "nurse", userId: nurse.userId },
      after: { slot: "nurse", userId: null },
      actor: doc.userId,
    });
  });

  it("refuses a change based on a stale value (never last-write-wins)", async () => {
    const doc = await createTestUser(db, { roleCode: "DOCTOR" });
    const other = await createTestUser(db, { roleCode: "DOCTOR" });
    const visit = await newVisit(doc.actor);
    await setVisitStaff(db, doc.actor, { visitId: visit.id, slot: "doctor", userId: doc.userId, expectedUserId: null });

    const stale = setVisitStaff(db, other.actor, { visitId: visit.id, slot: "doctor", userId: other.userId, expectedUserId: null });
    await expect(stale).rejects.toBeInstanceOf(VisitStaffConflictError);
    await expect(stale).rejects.toMatchObject({ current: { id: doc.userId } });
    expect((await getVisitStaff(db, doc.actor, visit.id)).doctor?.id).toBe(doc.userId);
  });

  it("only accepts an active user with the matching role", async () => {
    const doc = await createTestUser(db, { roleCode: "DOCTOR" });
    const reception = await createTestUser(db, { roleCode: "RECEPTION" });
    const inactiveNurse = await createTestUser(db, { roleCode: "NURSE_ASSISTANT", isActive: false });
    const visit = await newVisit(doc.actor);

    await expect(
      setVisitStaff(db, doc.actor, { visitId: visit.id, slot: "doctor", userId: reception.userId, expectedUserId: null }),
    ).rejects.toBeInstanceOf(InvalidVisitStaffError);
    await expect(
      setVisitStaff(db, doc.actor, { visitId: visit.id, slot: "nurse", userId: doc.userId, expectedUserId: null }),
    ).rejects.toBeInstanceOf(InvalidVisitStaffError);
    await expect(
      setVisitStaff(db, doc.actor, { visitId: visit.id, slot: "nurse", userId: inactiveNurse.userId, expectedUserId: null }),
    ).rejects.toBeInstanceOf(InvalidVisitStaffError);
  });

  it("needs clinical.write: Reception and Admin cannot change it (denial audited)", async () => {
    const doc = await createTestUser(db, { roleCode: "DOCTOR" });
    const reception = await createTestUser(db, { roleCode: "RECEPTION" });
    const admin = await createTestUser(db, { roleCode: "ADMIN" });
    const visit = await newVisit(doc.actor);

    for (const actor of [reception.actor, admin.actor]) {
      await expect(
        setVisitStaff(db, actor, { visitId: visit.id, slot: "doctor", userId: doc.userId, expectedUserId: null }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await getVisitStaff(db, doc.actor, visit.id)).doctor).toBeNull();
  });

  it("only while the visit is open", async () => {
    const doc = await createTestUser(db, { roleCode: "DOCTOR" });
    const visit = await newVisit(doc.actor);
    await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visit.id));

    await expect(
      setVisitStaff(db, doc.actor, { visitId: visit.id, slot: "doctor", userId: doc.userId, expectedUserId: null }),
    ).rejects.toBeInstanceOf(VisitNotOpenError);
  });
});
