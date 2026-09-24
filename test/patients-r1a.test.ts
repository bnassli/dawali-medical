import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, demographicOptions, patients } from "@/db/schema";
import { ForbiddenError } from "@/modules/permissions/service";
import { EXTERNAL_ID_SYSTEMS } from "@/modules/patients/constants";
import { createPatientSchema, searchPatientsSchema } from "@/modules/patients/schema";
import {
  addDemographicOption,
  createPatient,
  DuplicateDemographicOptionError,
  DuplicateExternalIdError,
  externalIdOf,
  InvalidDemographicOptionError,
  listDemographicOptions,
  PatientConflictError,
  searchPatients,
  setDemographicOptionActive,
  setPatientActive,
  updatePatient,
  type PatientRecord,
} from "@/modules/patients/service";
import { createVisit, PatientInactiveError } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix, type TestUser } from "./helpers";

/** The update input that re-saves a patient unchanged (plus overrides). */
function asUpdate(p: PatientRecord, overrides: Record<string, unknown> = {}) {
  return {
    id: p.id,
    expectedVersion: p.version,
    firstName: p.firstName,
    lastName: p.lastName,
    middleName: p.middleName ?? undefined,
    dateOfBirth: p.dateOfBirth ?? undefined,
    sex: (p.sex ?? undefined) as "F" | "M" | undefined,
    phone: p.phone ?? undefined,
    email: p.email ?? undefined,
    icareFileNo: externalIdOf(p, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO) ?? undefined,
    nationalId: externalIdOf(p, EXTERNAL_ID_SYSTEMS.NATIONAL_ID) ?? undefined,
    nationalityOptionId: p.nationalityOptionId ?? undefined,
    preferredLanguageOptionId: p.preferredLanguageOptionId ?? undefined,
    insuranceId: p.insuranceId ?? undefined,
    emergencyContactName: p.emergencyContactName ?? undefined,
    emergencyContactPhone: p.emergencyContactPhone ?? undefined,
    emergencyContactRelationship: p.emergencyContactRelationship ?? undefined,
    ...overrides,
  };
}

describe("R1a patient demographics, search and inactive patients (ADR-028)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let reception: TestUser;
  let doctor: TestUser;
  let nurse: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    const opened = openTestDb();
    db = opened.db;
    close = opened.close;
    reception = await createTestUser(db, { roleCode: "RECEPTION" });
    doctor = await createTestUser(db, { roleCode: "DOCTOR" });
    nurse = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    admin = await createTestUser(db, { roleCode: "ADMIN" });
  });

  afterAll(async () => {
    await close();
  });

  async function newOption(listCode: "nationality" | "preferred_language") {
    return addDemographicOption(db, reception.actor, {
      listCode,
      label: `${listCode}-${uniqueSuffix()}`,
    });
  }

  describe("create / edit with the V1 fields", () => {
    it("stores every V1 field, resolves option labels and audits identifiers", async () => {
      const s = uniqueSuffix();
      const nationality = await newOption("nationality");
      const languages = await listDemographicOptions(db, reception.actor);
      const arabic = languages.preferred_language.find((o) => o.label === "Arabic");
      expect(arabic).toBeDefined();

      const p = await createPatient(db, reception.actor, {
        firstName: `Amal-${s}`,
        middleName: "B",
        lastName: `Saleh-${s}`,
        sex: "F",
        dateOfBirth: "1985-02-28",
        phone: `050-${s}`,
        email: `amal-${s}@example.test`,
        icareFileNo: `ICR-${s}`,
        nationalId: `NID-${s}`,
        insuranceId: `INS-${s}`,
        nationalityOptionId: nationality.id,
        preferredLanguageOptionId: arabic?.id,
        emergencyContactName: "Omar",
        emergencyContactPhone: "055",
        emergencyContactRelationship: "Brother",
      });

      expect(p.isActive).toBe(true);
      expect(p.version).toBe(1);
      expect(p.nationality?.label).toBe(nationality.label);
      expect(p.preferredLanguage?.label).toBe("Arabic");
      expect(externalIdOf(p, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO)).toBe(`ICR-${s}`);
      expect(externalIdOf(p, EXTERNAL_ID_SYSTEMS.NATIONAL_ID)).toBe(`NID-${s}`);
      expect(p.insuranceId).toBe(`INS-${s}`);
      expect(p.emergencyContactRelationship).toBe("Brother");

      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "patient.create"), eq(auditLogs.patientId, p.id)));
      const after = audit?.after as { externalIds: { system: string; value: string }[] };
      expect(after.externalIds).toEqual(
        expect.arrayContaining([
          { system: EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO, value: `ICR-${s}` },
          { system: EXTERNAL_ID_SYSTEMS.NATIONAL_ID, value: `NID-${s}` },
        ]),
      );
    });

    it("accepts only F / M / blank for sex (schema and database)", async () => {
      const base = { firstName: "A", lastName: "B" };
      expect(createPatientSchema.safeParse({ ...base, sex: "F" }).success).toBe(true);
      expect(createPatientSchema.safeParse({ ...base, sex: "" }).success).toBe(true);
      expect(createPatientSchema.safeParse({ ...base, sex: "female" }).success).toBe(false);
      expect(createPatientSchema.safeParse({ ...base, sex: "X" }).success).toBe(false);

      await expect(
        db.insert(patients).values({ firstName: "Raw", lastName: `Sex-${uniqueSuffix()}`, sex: "female" }),
      ).rejects.toThrow();
    });

    it("edits the File / Medical ID and National ID, and clears them, all audited", async () => {
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, {
        firstName: `Edit-${s}`,
        lastName: `Ids-${s}`,
        icareFileNo: `OLD-${s}`,
      });

      const changed = await updatePatient(
        db,
        reception.actor,
        asUpdate(p, { icareFileNo: `NEW-${s}`, nationalId: `NID2-${s}` }),
      );
      expect(changed.version).toBe(2);
      expect(externalIdOf(changed, EXTERNAL_ID_SYSTEMS.ICARE_FILE_NO)).toBe(`NEW-${s}`);
      expect(externalIdOf(changed, EXTERNAL_ID_SYSTEMS.NATIONAL_ID)).toBe(`NID2-${s}`);

      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "patient.update"), eq(auditLogs.patientId, p.id)));
      const before = audit?.before as { externalIds: { value: string }[] };
      const after = audit?.after as { externalIds: { value: string }[] };
      expect(before.externalIds.map((e) => e.value)).toEqual([`OLD-${s}`]);
      expect(after.externalIds.map((e) => e.value).sort()).toEqual([`NEW-${s}`, `NID2-${s}`].sort());

      const cleared = await updatePatient(
        db,
        reception.actor,
        asUpdate(changed, { icareFileNo: undefined, nationalId: undefined }),
      );
      expect(cleared.externalIds).toEqual([]);
    });

    it("rejects a File / Medical ID or National ID that belongs to another patient", async () => {
      const s = uniqueSuffix();
      await createPatient(db, reception.actor, {
        firstName: "Owner",
        lastName: `Ids-${s}`,
        icareFileNo: `TAKEN-${s}`,
        nationalId: `NTAKEN-${s}`,
      });
      const other = await createPatient(db, reception.actor, { firstName: "Other", lastName: `Ids-${s}` });

      await expect(
        updatePatient(db, reception.actor, asUpdate(other, { icareFileNo: `TAKEN-${s}` })),
      ).rejects.toBeInstanceOf(DuplicateExternalIdError);
      await expect(
        createPatient(db, reception.actor, { firstName: "Third", lastName: `Ids-${s}`, nationalId: `NTAKEN-${s}` }),
      ).rejects.toBeInstanceOf(DuplicateExternalIdError);
    });

    it("rejects a stale edit (optimistic concurrency) without changing anything", async () => {
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, { firstName: "Race", lastName: `Cond-${s}` });
      await updatePatient(db, reception.actor, asUpdate(p, { phone: "111" }));

      await expect(
        updatePatient(db, doctor.actor, asUpdate(p, { phone: "222" })),
      ).rejects.toBeInstanceOf(PatientConflictError);

      const [row] = await db.select().from(patients).where(eq(patients.id, p.id));
      expect(row?.phone).toBe("111");
      expect(row?.version).toBe(2);
      const audits = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "patient.update"), eq(auditLogs.patientId, p.id)));
      expect(audits).toHaveLength(1);
    });

    it("never changes the Inactive flag through a normal edit", async () => {
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, { firstName: "Keep", lastName: `Inactive-${s}` });
      const inactive = await setPatientActive(db, admin.actor, {
        id: p.id,
        isActive: false,
        expectedVersion: p.version,
      });
      const edited = await updatePatient(db, reception.actor, asUpdate(inactive, { phone: "123" }));
      expect(edited.isActive).toBe(false);
    });
  });

  describe("demographic option lists", () => {
    it("seeds Arabic and English as Preferred Language options", async () => {
      const lists = await listDemographicOptions(db, reception.actor);
      const labels = lists.preferred_language.map((o) => o.label);
      expect(labels).toEqual(expect.arrayContaining(["Arabic", "English"]));
    });

    it("lets Reception and Doctor add options (audited) but not Nurse/Assistant", async () => {
      const option = await newOption("nationality");
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "demographic_option.create"), eq(auditLogs.entityId, option.id)));
      expect(audit?.actorUserId).toBe(reception.userId);

      await expect(
        addDemographicOption(db, doctor.actor, { listCode: "nationality", label: `Doc-${uniqueSuffix()}` }),
      ).resolves.toMatchObject({ isActive: true });
      await expect(
        addDemographicOption(db, nurse.actor, { listCode: "nationality", label: `Nurse-${uniqueSuffix()}` }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("rejects a case-insensitive duplicate in the same list only", async () => {
      const label = `Dup-${uniqueSuffix()}`;
      await addDemographicOption(db, reception.actor, { listCode: "nationality", label });
      await expect(
        addDemographicOption(db, reception.actor, { listCode: "nationality", label: label.toUpperCase() }),
      ).rejects.toBeInstanceOf(DuplicateDemographicOptionError);
      await expect(
        addDemographicOption(db, reception.actor, { listCode: "preferred_language", label }),
      ).resolves.toMatchObject({ label });
    });

    it("rejects an option from the wrong list", async () => {
      const language = await newOption("preferred_language");
      await expect(
        createPatient(db, reception.actor, {
          firstName: "Wrong",
          lastName: `List-${uniqueSuffix()}`,
          nationalityOptionId: language.id,
        }),
      ).rejects.toBeInstanceOf(InvalidDemographicOptionError);
    });

    it("keeps a retired option on patients that have it, but refuses it for new selections", async () => {
      const option = await newOption("nationality");
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, {
        firstName: "Retired",
        lastName: `Opt-${s}`,
        nationalityOptionId: option.id,
      });

      await expect(
        setDemographicOptionActive(db, reception.actor, { optionId: option.id, isActive: false }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await setDemographicOptionActive(db, admin.actor, { optionId: option.id, isActive: false });

      const edited = await updatePatient(db, reception.actor, asUpdate(p, { phone: "9" }));
      expect(edited.nationality).toMatchObject({ id: option.id, isActive: false });

      await expect(
        createPatient(db, reception.actor, {
          firstName: "New",
          lastName: `Opt-${s}`,
          nationalityOptionId: option.id,
        }),
      ).rejects.toBeInstanceOf(InvalidDemographicOptionError);

      const [row] = await db.select().from(demographicOptions).where(eq(demographicOptions.id, option.id));
      expect(row?.isActive).toBe(false);
    });
  });

  describe("Patient Search", () => {
    it("finds patients by a shared (non-unique) Insurance ID, prefix, case-insensitive, literally", async () => {
      const s = uniqueSuffix();
      const ins = `Ins_${s}`;
      const a = await createPatient(db, reception.actor, { firstName: "Fam", lastName: `One-${s}`, insuranceId: ins });
      const b = await createPatient(db, reception.actor, { firstName: "Fam", lastName: `Two-${s}`, insuranceId: ins });
      const lookalike = await createPatient(db, reception.actor, {
        firstName: "Fam",
        lastName: `Three-${s}`,
        insuranceId: `InsX${s}`,
      });

      const exact = await searchPatients(db, reception.actor, { insuranceId: ins.toUpperCase() });
      expect(exact.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());

      const prefix = await searchPatients(db, reception.actor, { insuranceId: `ins_${s.slice(0, 3)}` });
      expect(prefix.map((p) => p.id)).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(prefix.some((p) => p.id === lookalike.id)).toBe(false);
    });

    it("searches first and last name separately", async () => {
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, { firstName: `Nour-${s}`, lastName: `Haddad-${s}` });
      const swapped = await createPatient(db, reception.actor, { firstName: `Haddad-${s}`, lastName: `Nour-${s}` });

      const both = await searchPatients(db, reception.actor, { firstName: `nour-${s}`, lastName: `HADDAD-${s}` });
      expect(both.map((r) => r.id)).toEqual([p.id]);

      const lastOnly = await searchPatients(db, reception.actor, { lastName: `Nour-${s}` });
      expect(lastOnly.map((r) => r.id)).toEqual([swapped.id]);
    });

    it("matches Medical / File ID against the iCare number only (not National ID)", async () => {
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, {
        firstName: "File",
        lastName: `Only-${s}`,
        nationalId: `FID-${s}`,
      });
      const byFileId = await searchPatients(db, reception.actor, { externalId: `FID-${s}` });
      expect(byFileId.some((r) => r.id === p.id)).toBe(false);
    });

    it("requires a real criterion (Include inactive alone is not one)", () => {
      expect(searchPatientsSchema.safeParse({ includeInactive: true }).success).toBe(false);
      expect(searchPatientsSchema.safeParse({ insuranceId: "X" }).success).toBe(true);
    });

    it("hides inactive patients by default and shows them with Include inactive", async () => {
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, { firstName: "Hidden", lastName: `Inactive-${s}` });
      await setPatientActive(db, admin.actor, { id: p.id, isActive: false, expectedVersion: p.version });

      const hidden = await searchPatients(db, reception.actor, { lastName: `Inactive-${s}` });
      expect(hidden).toEqual([]);

      const shown = await searchPatients(db, reception.actor, {
        lastName: `Inactive-${s}`,
        includeInactive: true,
      });
      expect(shown.map((r) => ({ id: r.id, isActive: r.isActive }))).toEqual([{ id: p.id, isActive: false }]);
    });
  });

  describe("Inactive Patient (Admin only)", () => {
    it("allows only Admin to change it, audits it and blocks new visits until reactivated", async () => {
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, { firstName: "Block", lastName: `Visits-${s}` });

      for (const user of [reception, doctor, nurse]) {
        await expect(
          setPatientActive(db, user.actor, { id: p.id, isActive: false, expectedVersion: p.version }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }

      const inactive = await setPatientActive(db, admin.actor, {
        id: p.id,
        isActive: false,
        expectedVersion: p.version,
      });
      expect(inactive.isActive).toBe(false);
      expect(inactive.version).toBe(p.version + 1);

      await expect(
        createVisit(db, reception.actor, { patientId: p.id, reason: undefined }),
      ).rejects.toBeInstanceOf(PatientInactiveError);

      const [{ visitAudits } = { visitAudits: -1 }] = await db
        .select({ visitAudits: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "visit.create"), eq(auditLogs.patientId, p.id)));
      expect(visitAudits).toBe(0);

      const active = await setPatientActive(db, admin.actor, {
        id: p.id,
        isActive: true,
        expectedVersion: inactive.version,
      });
      expect(active.isActive).toBe(true);
      await expect(
        createVisit(db, reception.actor, { patientId: p.id, reason: undefined }),
      ).resolves.toMatchObject({ patientId: p.id });

      const actions = await db
        .select({ action: auditLogs.action, before: auditLogs.before, after: auditLogs.after })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.patientId, p.id),
            sql`${auditLogs.action} IN ('patient.deactivate', 'patient.reactivate')`,
          ),
        )
        .orderBy(auditLogs.id);
      expect(actions.map((a) => a.action)).toEqual(["patient.deactivate", "patient.reactivate"]);
      expect(actions[0]?.before).toMatchObject({ isActive: true });
      expect(actions[0]?.after).toMatchObject({ isActive: false });
    });

    it("rejects a stale deactivation", async () => {
      const s = uniqueSuffix();
      const p = await createPatient(db, reception.actor, { firstName: "Stale", lastName: `Flag-${s}` });
      await updatePatient(db, reception.actor, asUpdate(p, { phone: "1" }));
      await expect(
        setPatientActive(db, admin.actor, { id: p.id, isActive: false, expectedVersion: p.version }),
      ).rejects.toBeInstanceOf(PatientConflictError);
    });
  });
});
