import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLogs,
  clinicalEntries,
  clinicalFieldDefinitions,
  clinicalOptions,
  visits,
} from "@/db/schema";
import {
  addClinicalOption,
  ClinicalFieldNotFoundError,
  DuplicateOptionError,
  getClinicalSectionForVisit,
  InvalidClinicalValueError,
  listOptionListsForAdmin,
  setClinicalOptionActive,
  VisitNotOpenError,
} from "@/modules/clinical/service";
import { SUBJ_COMPLAINTS_HABITS_SECTION_CODE } from "@/modules/clinical/definitions";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, saveCurrent, uniqueSuffix } from "./helpers";

describe("clinical entries (Subj Complaints Habits)", () => {
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
    const suffix = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `Cara-${suffix}`,
      lastName: `Clinic-${suffix}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    const visit = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
    return { patient, visit };
  }

  async function fieldId(code: string): Promise<string> {
    const [row] = await db
      .select({ id: clinicalFieldDefinitions.id })
      .from(clinicalFieldDefinitions)
      .where(eq(clinicalFieldDefinitions.code, code))
      .limit(1);
    if (!row) throw new Error(`field ${code} not seeded`);
    return row.id;
  }

  it("seeds the section with fields in CLINICAL_TABS.md order and no option values", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);

    const view = await getClinicalSectionForVisit(
      db,
      actor,
      visit.id,
      SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    );

    expect(view.fields.map((f) => f.code).slice(0, 4)).toEqual([
      "reason_for_visit",
      "problem_list",
      "chief_complaints",
      "characteristics",
    ]);
    expect(view.fields.at(-1)?.code).toBe("allergies_no_known");
    expect(view.fields.every((f) => f.version === 0)).toBe(true);
  });

  it("saves as append-only versions, audits create/update, and is a no-op when unchanged", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit, patient } = await newVisit(actor);
    const chestId = await fieldId("chest_comments");

    const first = await saveCurrent(db, actor, {
      visitId: visit.id,
      fieldId: chestId,
      optionIds: [],
      freeText: "  mild tightness  ",
    });
    expect(first.changed).toBe(true);
    expect(first.entry?.version).toBe(1);
    expect(first.entry?.value.freeText).toBe("mild tightness");

    const unchanged = await saveCurrent(db, actor, {
      visitId: visit.id,
      fieldId: chestId,
      optionIds: [],
      freeText: "mild tightness",
    });
    expect(unchanged.changed).toBe(false);

    const second = await saveCurrent(db, actor, {
      visitId: visit.id,
      fieldId: chestId,
      optionIds: [],
      freeText: "resolved",
    });
    expect(second.entry?.version).toBe(2);

    const rows = await db
      .select()
      .from(clinicalEntries)
      .where(and(eq(clinicalEntries.visitId, visit.id), eq(clinicalEntries.fieldDefinitionId, chestId)))
      .orderBy(asc(clinicalEntries.version));
    expect(rows.map((r) => r.value.freeText)).toEqual(["mild tightness", "resolved"]);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visit.id), eq(auditLogs.entityType, "clinical_entry")))
      .orderBy(asc(auditLogs.id));
    expect(audits.map((a) => a.action)).toEqual([
      "clinical_entry.create",
      "clinical_entry.update",
    ]);
    expect(audits.every((a) => a.patientId === patient.id)).toBe(true);
    expect(audits[1]?.before).toMatchObject({ version: 1 });
    expect(audits[1]?.after).toMatchObject({ version: 2 });

    // Loads back with the latest version.
    const view = await getClinicalSectionForVisit(
      db,
      actor,
      visit.id,
      SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    );
    const chest = view.fields.find((f) => f.code === "chest_comments");
    expect(chest?.version).toBe(2);
    expect(chest?.value.freeText).toBe("resolved");
  });

  it("does not create a version for an empty first save", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const result = await saveCurrent(db, actor, {
      visitId: visit.id,
      fieldId: await fieldId("comments"),
      optionIds: [],
      freeText: "   ",
    });
    expect(result).toMatchObject({ changed: false, replayed: false, version: 0, entry: null });
    const rows = await db
      .select()
      .from(clinicalEntries)
      .where(eq(clinicalEntries.visitId, visit.id));
    expect(rows).toHaveLength(0);
  });

  it("+ Add New persists an option permanently; visit-only free text does not", async () => {
    const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit: visitA } = await newVisit(doctor);
    const { visit: visitB } = await newVisit(doctor);
    const fid = await fieldId("chief_complaints");
    const label = `Leg swelling ${uniqueSuffix()}`;

    const option = await addClinicalOption(db, doctor, { fieldId: fid, label });
    expect(option.isActive).toBe(true);

    await saveCurrent(db, doctor, {
      visitId: visitA.id,
      fieldId: fid,
      optionIds: [option.id],
      freeText: `visit-only ${label}`,
    });

    const viewB = await getClinicalSectionForVisit(
      db,
      doctor,
      visitB.id,
      SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    );
    const fieldB = viewB.fields.find((f) => f.code === "chief_complaints");
    expect(fieldB?.options.map((o) => o.label)).toContain(label);
    expect(fieldB?.options.map((o) => o.label)).not.toContain(`visit-only ${label}`);
    expect(fieldB?.value).toEqual({ optionIds: [], freeText: "" });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "clinical_option.create"), eq(auditLogs.entityId, option.id)));
    expect(audit).toBeDefined();
  });

  it("rejects duplicate options case-insensitively", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const fid = await fieldId("allergies");
    const label = `Latex ${uniqueSuffix()}`;
    await addClinicalOption(db, actor, { fieldId: fid, label });
    await expect(
      addClinicalOption(db, actor, { fieldId: fid, label: label.toUpperCase() }),
    ).rejects.toBeInstanceOf(DuplicateOptionError);
  });

  it("cannot add options to a text field", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    await expect(
      addClinicalOption(db, actor, { fieldId: await fieldId("comments"), label: "x" }),
    ).rejects.toBeInstanceOf(ClinicalFieldNotFoundError);
  });

  it("validates values: single-select cardinality, foreign options, text fields", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const durationId = await fieldId("duration");
    const progressionId = await fieldId("progression");
    const suffix = uniqueSuffix();
    const a = await addClinicalOption(db, actor, { fieldId: durationId, label: `A ${suffix}` });
    const b = await addClinicalOption(db, actor, { fieldId: durationId, label: `B ${suffix}` });

    await expect(
      saveCurrent(db, actor, {
        visitId: visit.id,
        fieldId: durationId,
        optionIds: [a.id, b.id],
        freeText: "",
      }),
    ).rejects.toBeInstanceOf(InvalidClinicalValueError);

    // Option belongs to another field's list.
    await expect(
      saveCurrent(db, actor, {
        visitId: visit.id,
        fieldId: progressionId,
        optionIds: [a.id],
        freeText: "",
      }),
    ).rejects.toBeInstanceOf(InvalidClinicalValueError);

    await expect(
      saveCurrent(db, actor, {
        visitId: visit.id,
        fieldId: await fieldId("comments"),
        optionIds: [a.id],
        freeText: "",
      }),
    ).rejects.toBeInstanceOf(InvalidClinicalValueError);
  });

  it("retired options stay on existing entries but cannot be newly selected", async () => {
    const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: admin } = await createTestUser(db, { roleCode: "ADMIN" });
    const { visit } = await newVisit(doctor);
    const fid = await fieldId("current_meds");
    const suffix = uniqueSuffix();
    const kept = await addClinicalOption(db, doctor, { fieldId: fid, label: `Kept ${suffix}` });
    const other = await addClinicalOption(db, doctor, { fieldId: fid, label: `Other ${suffix}` });

    await saveCurrent(db, doctor, {
      visitId: visit.id,
      fieldId: fid,
      optionIds: [kept.id],
      freeText: "",
    });
    await setClinicalOptionActive(db, admin, { optionId: kept.id, isActive: false });
    await setClinicalOptionActive(db, admin, { optionId: other.id, isActive: false });

    // Historical selection still loads and can be re-saved with a comment.
    const view = await getClinicalSectionForVisit(
      db,
      doctor,
      visit.id,
      SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    );
    const field = view.fields.find((f) => f.code === "current_meds");
    expect(field?.options.map((o) => o.id)).toEqual([kept.id]);
    await expect(
      saveCurrent(db, doctor, {
        visitId: visit.id,
        fieldId: fid,
        optionIds: [kept.id],
        freeText: "still taking",
      }),
    ).resolves.toMatchObject({ changed: true });

    await expect(
      saveCurrent(db, doctor, {
        visitId: visit.id,
        fieldId: fid,
        optionIds: [kept.id, other.id],
        freeText: "still taking",
      }),
    ).rejects.toBeInstanceOf(InvalidClinicalValueError);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "clinical_option.update"), eq(auditLogs.entityId, kept.id)));
    expect(audit?.before).toMatchObject({ isActive: true });
    expect(audit?.after).toMatchObject({ isActive: false });
  });

  it("rejects writes on a visit that is not open, and never mutates it", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const cid = await fieldId("comments");
    await saveCurrent(db, actor, {
      visitId: visit.id,
      fieldId: cid,
      optionIds: [],
      freeText: "before close",
    });

    await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visit.id));

    await expect(
      saveCurrent(db, actor, {
        visitId: visit.id,
        fieldId: cid,
        optionIds: [],
        freeText: "after close",
      }),
    ).rejects.toBeInstanceOf(VisitNotOpenError);

    const rows = await db
      .select()
      .from(clinicalEntries)
      .where(eq(clinicalEntries.visitId, visit.id));
    expect(rows).toHaveLength(1);
  });

  it("enforces role permissions and audits denials", async () => {
    const { actor: doctor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { actor: nurse } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
    const { actor: admin } = await createTestUser(db, { roleCode: "ADMIN" });
    const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
    const { visit } = await newVisit(doctor);
    const commentsId = await fieldId("comments");
    const allergiesId = await fieldId("allergies");

    // Nurse: read + write (incl. visit-only free text) but no permanent options.
    await expect(
      saveCurrent(db, nurse, {
        visitId: visit.id,
        fieldId: allergiesId,
        optionIds: [],
        freeText: "visit-only note",
      }),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      addClinicalOption(db, nurse, { fieldId: allergiesId, label: `N ${uniqueSuffix()}` }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Admin: read + add + manage, but NOT clinical.write.
    await expect(
      getClinicalSectionForVisit(db, admin, visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE),
    ).resolves.toBeDefined();
    await expect(
      addClinicalOption(db, admin, { fieldId: allergiesId, label: `Adm ${uniqueSuffix()}` }),
    ).resolves.toBeDefined();
    await expect(listOptionListsForAdmin(db, admin)).resolves.toBeDefined();
    await expect(
      saveCurrent(db, admin, {
        visitId: visit.id,
        fieldId: commentsId,
        optionIds: [],
        freeText: "admin edit",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Doctor cannot manage lists; reception has no clinical access at all.
    await expect(listOptionListsForAdmin(db, doctor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      getClinicalSectionForVisit(db, reception, visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      saveCurrent(db, reception, {
        visitId: visit.id,
        fieldId: commentsId,
        optionIds: [],
        freeText: "x",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const denied = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "access.denied"), eq(auditLogs.actorUserId, reception.userId)));
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied.some((d) => d.visitId === visit.id)).toBe(true);
  });

  it("database rejects UPDATE and DELETE on clinical_entries", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const { visit } = await newVisit(actor);
    const result = await saveCurrent(db, actor, {
      visitId: visit.id,
      fieldId: await fieldId("comments"),
      optionIds: [],
      freeText: "immutable",
    });
    const id = result.entry?.id ?? "";

    await expect(
      db
        .update(clinicalEntries)
        .set({ value: { optionIds: [], freeText: "tampered" } })
        .where(eq(clinicalEntries.id, id)),
    ).rejects.toThrow();
    await expect(db.delete(clinicalEntries).where(eq(clinicalEntries.id, id))).rejects.toThrow();
  });

  it("seeding creates no option rows (options only come from + Add New)", async () => {
    const rows = await db
      .select({ id: clinicalOptions.id, createdBy: clinicalOptions.createdBy })
      .from(clinicalOptions);
    expect(rows.every((r) => r.createdBy !== null)).toBe(true);
  });
});
