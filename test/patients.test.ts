import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, patients } from "@/db/schema";
import { ForbiddenError } from "@/modules/permissions/service";
import {
  createPatient,
  DuplicateExternalIdError,
  searchPatients,
  updatePatient,
} from "@/modules/patients/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

/** Fills in the other optional search fields as undefined for the type. */
function crit(partial: {
  name?: string;
  externalId?: string;
  phone?: string;
  dateOfBirth?: string;
}) {
  return {
    name: undefined,
    externalId: undefined,
    phone: undefined,
    dateOfBirth: undefined,
    ...partial,
  };
}

describe("patients", () => {
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

  it("creates a patient and writes a patient.create audit row with after-state", async () => {
    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const suffix = uniqueSuffix();

    const patient = await createPatient(db, actor, {
      firstName: `Alice-${suffix}`,
      lastName: `Anderson-${suffix}`,
      middleName: undefined,
      dateOfBirth: "1990-05-12",
      sex: "F",
      phone: `555-${suffix}`,
      email: undefined,
      icareFileNo: undefined,
    });

    expect(patient.id).toBeTypeOf("string");
    expect(patient.firstName).toBe(`Alice-${suffix}`);

    const [auditRow] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "patient.create"), eq(auditLogs.patientId, patient.id)));

    expect(auditRow).toBeDefined();
    expect(auditRow?.actorUserId).toBe(actor.userId);
    const after = auditRow?.after as Record<string, unknown> | null;
    expect(after?.firstName).toBe(`Alice-${suffix}`);
    expect(after?.lastName).toBe(`Anderson-${suffix}`);
  });

  it("updates a patient and writes a patient.update audit row with before AND after", async () => {
    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const suffix = uniqueSuffix();

    const patient = await createPatient(db, actor, {
      firstName: `Bob-${suffix}`,
      lastName: `Baker-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });

    const updated = await updatePatient(db, actor, {
      id: patient.id,
      firstName: `Bob-${suffix}`,
      lastName: `Baker-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: `999-${suffix}`,
      email: undefined,
    });
    expect(updated.phone).toBe(`999-${suffix}`);

    const [auditRow] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "patient.update"), eq(auditLogs.patientId, patient.id)));

    expect(auditRow).toBeDefined();
    const before = auditRow?.before as Record<string, unknown> | null;
    const after = auditRow?.after as Record<string, unknown> | null;
    expect(before?.phone ?? null).toBeNull();
    expect(after?.phone).toBe(`999-${suffix}`);
  });

  it("searches patients by partial, case-insensitive name", async () => {
    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const suffix = uniqueSuffix();

    await createPatient(db, actor, {
      firstName: `Zelda-${suffix}`,
      lastName: `Quinnworth-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });

    // Search on a distinctive partial fragment of the last name, mixed case,
    // to exercise case-insensitive + partial matching in one assertion.
    const partial = `uinnWORTH-${suffix}`;
    const results = await searchPatients(db, actor, crit({ name: partial }));

    expect(results.some((p) => p.lastName === `Quinnworth-${suffix}`)).toBe(true);
  });

  it("searches patients by exact/prefix external file number", async () => {
    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const suffix = uniqueSuffix();
    const fileNo = `ICR-${suffix}`;

    const patient = await createPatient(db, actor, {
      firstName: `Carl-${suffix}`,
      lastName: `Carter-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: fileNo,
    });

    const exact = await searchPatients(db, actor, crit({ externalId: fileNo }));
    expect(exact.some((p) => p.id === patient.id)).toBe(true);

    const prefix = await searchPatients(db, actor, crit({ externalId: fileNo.slice(0, -2) }));
    expect(prefix.some((p) => p.id === patient.id)).toBe(true);

    const noMatch = await searchPatients(db, actor, crit({ externalId: `NOPE-${suffix}` }));
    expect(noMatch.some((p) => p.id === patient.id)).toBe(false);
  });

  it("finds a patient by file number even when more than 100 other patients sort before it", async () => {
    // Regression (PR #1 review): the external-ID filter used to run in
    // JavaScript AFTER ORDER BY last_name LIMIT 100, so a match outside the
    // alphabetically first 100 patients was silently dropped.
    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const suffix = uniqueSuffix();

    // 105 patients whose last names sort before every other test patient.
    await db.insert(patients).values(
      Array.from({ length: 105 }, (_, i) => ({
        firstName: `Filler-${i}`,
        lastName: `0000-${suffix}-${String(i).padStart(3, "0")}`,
      })),
    );

    const fileNo = `ICR-LATE-${suffix}`;
    const target = await createPatient(db, actor, {
      firstName: `Zed-${suffix}`,
      lastName: `zzzz-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: fileNo,
    });

    // Precondition: without a filter the target really is past the first page.
    const firstPage = await searchPatients(db, actor, crit({}));
    expect(firstPage).toHaveLength(100);
    expect(firstPage.some((p) => p.id === target.id)).toBe(false);

    const exact = await searchPatients(db, actor, crit({ externalId: fileNo }));
    expect(exact.map((p) => p.id)).toEqual([target.id]);

    const prefix = await searchPatients(db, actor, crit({ externalId: `ICR-LATE-${suffix.slice(0, 4)}` }));
    expect(prefix.some((p) => p.id === target.id)).toBe(true);
  });

  it("treats % and _ in search input literally, not as wildcards", async () => {
    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const suffix = uniqueSuffix();
    const make = (icareFileNo: string, lastName: string) =>
      createPatient(db, actor, {
        firstName: `Wild-${suffix}`,
        lastName,
        middleName: undefined,
        dateOfBirth: undefined,
        sex: undefined,
        phone: undefined,
        email: undefined,
        icareFileNo,
      });
    const literal = await make(`WLD-${suffix}-1_3`, `Under_score-${suffix}`);
    const lookalike = await make(`WLD-${suffix}-123`, `Underxscore-${suffix}`);

    const byFileNo = await searchPatients(db, actor, crit({ externalId: `WLD-${suffix}-1_` }));
    expect(byFileNo.map((p) => p.id)).toEqual([literal.id]);

    const byName = await searchPatients(db, actor, crit({ name: `Under_score-${suffix}` }));
    expect(byName.map((p) => p.id)).toEqual([literal.id]);
    expect(byName.some((p) => p.id === lookalike.id)).toBe(false);

    const percent = await searchPatients(db, actor, crit({ name: "%" }));
    expect(percent).toEqual([]);
  });

  it("searches patients by phone", async () => {
    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const suffix = uniqueSuffix();
    const phone = `5551234-${suffix}`;

    const patient = await createPatient(db, actor, {
      firstName: `Dana-${suffix}`,
      lastName: `Diaz-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone,
      email: undefined,
      icareFileNo: undefined,
    });

    const results = await searchPatients(db, actor, crit({ phone }));
    expect(results.some((p) => p.id === patient.id)).toBe(true);
  });

  it("rejects a duplicate external file number with a clear error", async () => {
    const { actor } = await createTestUser(db, { roleCode: "RECEPTION" });
    const suffix = uniqueSuffix();
    const fileNo = `DUP-${suffix}`;

    await createPatient(db, actor, {
      firstName: `Eve-${suffix}`,
      lastName: `Evans-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: fileNo,
    });

    await expect(
      createPatient(db, actor, {
        firstName: `Frank-${suffix}`,
        lastName: `Foster-${suffix}`,
        middleName: undefined,
        dateOfBirth: undefined,
        sex: undefined,
        phone: undefined,
        email: undefined,
        icareFileNo: fileNo,
      }),
    ).rejects.toBeInstanceOf(DuplicateExternalIdError);
  });

  it("denies patient creation for a role without patient.create and audits access.denied", async () => {
    const { actor } = await createTestUser(db, { roleCode: "INVENTORY" });
    const suffix = uniqueSuffix();

    await expect(
      createPatient(db, actor, {
        firstName: `Gina-${suffix}`,
        lastName: `Garcia-${suffix}`,
        middleName: undefined,
        dateOfBirth: undefined,
        sex: undefined,
        phone: undefined,
        email: undefined,
        icareFileNo: undefined,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "access.denied"), eq(auditLogs.actorUserId, actor.userId)));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("denies patient update for NURSE_ASSISTANT (patient.read/visit.read/visit.create only)", async () => {
    const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
    const { actor: nurse } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const suffix = uniqueSuffix();

    const patient = await createPatient(db, reception, {
      firstName: `Hank-${suffix}`,
      lastName: `Hill-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });

    await expect(
      updatePatient(db, nurse, {
        id: patient.id,
        firstName: `Hank-${suffix}`,
        lastName: `Hill-${suffix}`,
        middleName: undefined,
        dateOfBirth: undefined,
        sex: undefined,
        phone: "000",
        email: undefined,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
