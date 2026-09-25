import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Database } from "@/db/client";
import { runMigrations } from "@/db/migrator";
import {
  clinicalEntries,
  clinicalFieldDefinitions,
  clinicalOptionLists,
  clinicalSectionFields,
  clinicalSections,
  patients,
  visits,
} from "@/db/schema";
import { seed, seedClinicalDefinitions } from "@/db/seed";
import {
  ASSESSMENT_PLAN_SECTION_CODE,
  FIELD_TYPES,
  PAST_MEDICAL_HX_SECTION_CODE,
  STOCKING_MEASUREMENT_UNIT,
  SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
  type ClinicalDefinitions,
} from "@/modules/clinical/definitions";
import {
  addClinicalOption,
  ClinicalExclusionError,
  ClinicalFieldNotFoundError,
  getClinicalSectionForVisit,
  InvalidClinicalValueError,
} from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import {
  createTestUser,
  getTestConnectionString,
  openTestDb,
  saveCurrent,
  uniqueSuffix,
} from "./helpers";

describe("R1b: new field types and rules (ADR-029)", () => {
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

  async function doctor() {
    return (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
  }

  async function newVisit(actor: ActorContext, sex: "F" | "M" | null = null) {
    const s = uniqueSuffix();
    const patient = await createPatient(db, actor, {
      firstName: `R1b-${s}`,
      lastName: `Tabs-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    if (sex) await db.update(patients).set({ sex }).where(eq(patients.id, patient.id));
    const visit = await createVisit(db, actor, { patientId: patient.id, reason: undefined });
    return { visit, patientId: patient.id };
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

  async function history(visitId: string, code: string) {
    return db
      .select({ version: clinicalEntries.version, value: clinicalEntries.value })
      .from(clinicalEntries)
      .where(
        and(eq(clinicalEntries.visitId, visitId), eq(clinicalEntries.fieldDefinitionId, await fieldId(code))),
      )
      .orderBy(asc(clinicalEntries.version));
  }

  const text = (visitId: string, fid: string, freeText: string) => ({
    visitId,
    fieldId: fid,
    optionIds: [] as string[],
    freeText,
  });

  describe("number fields (stocking measurements, AP5)", () => {
    it("stores canonical decimal text in centimetres", async () => {
      expect(STOCKING_MEASUREMENT_UNIT).toBe("cm");
      const d = await doctor();
      const { visit } = await newVisit(d);
      const fid = await fieldId("stockings_mid_thigh");
      const r = await saveCurrent(db, d, text(visit.id, fid, " 054.5 "));
      expect(r.value).toEqual({ optionIds: [], freeText: "54.5" });
      // the same number written differently is a no-op (no revision, no audit row)
      const again = await saveCurrent(db, d, text(visit.id, fid, "54.5"));
      expect(again.changed).toBe(false);
      // clearing is allowed
      const cleared = await saveCurrent(db, d, text(visit.id, fid, ""));
      expect(cleared.value.freeText).toBe("");
      expect((await history(visit.id, "stockings_mid_thigh")).map((h) => h.value.freeText)).toEqual([
        "54.5",
        "",
      ]);
    });

    it("rejects text, too many decimals, out-of-range values and options; nothing is written", async () => {
      const d = await doctor();
      const { visit } = await newVisit(d);
      const fid = await fieldId("stockings_floor_to_knee");
      for (const bad of ["abc", "12.34", "201", "-3", "1e2", "12,5"]) {
        await expect(saveCurrent(db, d, text(visit.id, fid, bad)), bad).rejects.toBeInstanceOf(
          InvalidClinicalValueError,
        );
      }
      await expect(
        saveCurrent(db, d, { visitId: visit.id, fieldId: fid, optionIds: [randomUUID()], freeText: "" }),
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
      await expect(
        saveCurrent(db, d, { ...text(visit.id, fid, "40"), checked: true }),
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
      expect(await history(visit.id, "stockings_floor_to_knee")).toHaveLength(0);
      expect((await saveCurrent(db, d, text(visit.id, fid, "200"))).value.freeText).toBe("200");
    });
  });

  describe("choice field (Bullets / Numbers, AP4)", () => {
    it("accepts only its fixed values", async () => {
      const d = await doctor();
      const { visit } = await newVisit(d);
      const fid = await fieldId("impression_list_style");
      expect((await saveCurrent(db, d, text(visit.id, fid, "numbers"))).value.freeText).toBe("numbers");
      await expect(saveCurrent(db, d, text(visit.id, fid, "stars"))).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
      expect((await saveCurrent(db, d, text(visit.id, fid, "bullets"))).value.freeText).toBe("bullets");
    });
  });

  describe("female statement (P2)", () => {
    it("is saved for a female patient and refused otherwise; clearing is always allowed", async () => {
      const d = await doctor();
      const s = uniqueSuffix();
      const fid = await fieldId("female_statement");
      const opt = await addClinicalOption(db, d, { fieldId: fid, label: `G2P2 NSVD ${s}` });

      const female = await newVisit(d, "F");
      const ok = await saveCurrent(db, d, { visitId: female.visit.id, fieldId: fid, optionIds: [opt.id], freeText: "" });
      expect(ok.changed).toBe(true);

      for (const sex of ["M", null] as const) {
        const other = await newVisit(d, sex);
        await expect(
          saveCurrent(db, d, { visitId: other.visit.id, fieldId: fid, optionIds: [opt.id], freeText: "" }),
          String(sex),
        ).rejects.toBeInstanceOf(InvalidClinicalValueError);
        await expect(saveCurrent(db, d, text(other.visit.id, fid, "free text too"))).rejects.toBeInstanceOf(
          InvalidClinicalValueError,
        );
        expect(await history(other.visit.id, "female_statement")).toHaveLength(0);
      }

      // A later sex correction must not trap the old value: clearing still works.
      await db.update(patients).set({ sex: "M" }).where(eq(patients.id, female.patientId));
      const cleared = await saveCurrent(db, d, text(female.visit.id, fid, ""));
      expect(cleared.changed).toBe(true);
    });

    it("the section view exposes the patient's sex so the UI can enable the field", async () => {
      const d = await doctor();
      const { visit } = await newVisit(d, "F");
      const pmh = await getClinicalSectionForVisit(db, d, visit.id, PAST_MEDICAL_HX_SECTION_CODE);
      expect(pmh.visit.patientSex).toBe("F");
    });
  });

  describe("None / No known (S5, S6)", () => {
    for (const [flag, list] of [
      ["current_meds_none", "current_meds"],
      ["allergies_no_known", "allergies"],
    ] as const) {
      it(`${flag} and ${list} cannot both hold a value on one visit`, async () => {
        const d = await doctor();
        const { visit } = await newVisit(d);
        const flagId = await fieldId(flag);
        const listId = await fieldId(list);
        await saveCurrent(db, d, text(visit.id, listId, "aspirin"));
        await expect(
          saveCurrent(db, d, { ...text(visit.id, flagId, ""), checked: true }),
        ).rejects.toBeInstanceOf(ClinicalExclusionError);
        await saveCurrent(db, d, text(visit.id, listId, ""));
        await saveCurrent(db, d, { ...text(visit.id, flagId, ""), checked: true });
        await expect(saveCurrent(db, d, text(visit.id, listId, "ibuprofen"))).rejects.toBeInstanceOf(
          ClinicalExclusionError,
        );
      });
    }
  });

  describe("ordered rows (AP1, AP2)", () => {
    it("all Impression rows share one option list; each row has its own version stream", async () => {
      const d = await doctor();
      const { visit } = await newVisit(d);
      const s = uniqueSuffix();
      const opt = await addClinicalOption(db, d, { fieldId: await fieldId("impression_3"), label: `CVD C1 ${s}` });
      const a = await getClinicalSectionForVisit(db, d, visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      for (let i = 1; i <= 8; i++) {
        expect(a.fields.find((f) => f.code === `impression_${i}`)?.options.map((o) => o.id)).toContain(opt.id);
        expect(a.fields.find((f) => f.code === `recommendation_${i}`)?.options.map((o) => o.id)).not.toContain(
          opt.id,
        );
      }
      await saveCurrent(db, d, { visitId: visit.id, fieldId: await fieldId("impression_2"), optionIds: [opt.id], freeText: "" });
      await saveCurrent(db, d, text(visit.id, await fieldId("impression_1"), "asymptomatic"));
      expect(await history(visit.id, "impression_1")).toHaveLength(1);
      expect(await history(visit.id, "impression_2")).toHaveLength(1);
      expect(await history(visit.id, "impression_3")).toHaveLength(0);
    });
  });
});

/**
 * Migration 0007 on a database that has Sprint 3A data: build the old
 * structure on a throwaway database with every migration except 0007, add
 * entries, then apply 0007 through the real migrator and re-seed.
 */
describe("R1b: migration 0007 on existing data", () => {
  const LEGACY: ClinicalDefinitions = {
    fields: [
      { code: "reason_for_visit", label: "Reason for Visit", type: FIELD_TYPES.SELECT },
      { code: "family_history", label: "Family History", type: FIELD_TYPES.MULTISELECT },
      { code: "past_medical_history", label: "Past Medical Hx", type: FIELD_TYPES.MULTISELECT },
      { code: "past_medical_unknown", label: "Unknown", type: FIELD_TYPES.CHECKBOX },
      { code: "past_medical_additional_comments", label: "Additional Comments", type: FIELD_TYPES.TEXTAREA },
      { code: "impression", label: "Impression", type: FIELD_TYPES.MULTISELECT },
      { code: "recommendations", label: "Recommendations", type: FIELD_TYPES.MULTISELECT },
      { code: "stockings_measurements", label: "Stockings Measurements", type: FIELD_TYPES.TEXTAREA },
    ],
    sections: [
      {
        code: SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
        name: "Subj Complaints Habits",
        sortOrder: 1,
        fieldCodes: ["reason_for_visit", "family_history"],
      },
      {
        code: PAST_MEDICAL_HX_SECTION_CODE,
        name: "Past Medical Hx",
        sortOrder: 2,
        fieldCodes: ["past_medical_history", "family_history", "past_medical_unknown", "past_medical_additional_comments"],
        labelOverrides: { family_history: "Family Medical Hx" },
      },
      {
        code: ASSESSMENT_PLAN_SECTION_CODE,
        name: "Assessment Plan+",
        sortOrder: 3,
        fieldCodes: ["impression", "recommendations", "stockings_measurements"],
      },
    ],
  };

  const dbName = `dawali_r1b_${uniqueSuffix().replace(/-/g, "")}`;
  let url: string;
  let db: Database;
  let close: () => Promise<void>;
  let adminClose: () => Promise<void>;
  let admin: Database;
  let tmp: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const opened = openTestDb();
    admin = opened.db;
    adminClose = opened.close;
    await admin.execute(sql.raw(`CREATE DATABASE ${dbName}`));
    const u = new URL(getTestConnectionString());
    u.pathname = `/${dbName}`;
    url = u.toString();
    const conn = createDb(url);
    db = conn.db;
    close = () => conn.pool.end();

    // Every committed migration except 0007.
    tmp = mkdtempSync(path.join(os.tmpdir(), "dawali-mig-"));
    cpSync(path.resolve(process.cwd(), "drizzle"), tmp, { recursive: true });
    unlinkSync(path.join(tmp, "0007_r1b_sonosoft_reconciliation.sql"));
    const journalPath = path.join(tmp, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => !e.tag.startsWith("0007_"));
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: tmp });

    await seedClinicalDefinitions(db, LEGACY);
    const [patient] = await db.insert(patients).values({ firstName: "Old", lastName: "Data" }).returning();
    const [visit] = await db.insert(visits).values({ patientId: patient!.id }).returning();
    ids.visit = visit!.id;
    const rows = await db.select().from(clinicalFieldDefinitions);
    for (const r of rows) ids[r.code] = r.id;
    await db.insert(clinicalEntries).values([
      { visitId: visit!.id, fieldDefinitionId: ids.impression!, version: 1, value: { optionIds: [], freeText: "old impression" } },
      { visitId: visit!.id, fieldDefinitionId: ids.past_medical_unknown!, version: 1, value: { optionIds: [], freeText: "", checked: true } },
      { visitId: visit!.id, fieldDefinitionId: ids.past_medical_additional_comments!, version: 1, value: { optionIds: [], freeText: "old note" } },
      { visitId: visit!.id, fieldDefinitionId: ids.family_history!, version: 1, value: { optionIds: [], freeText: "mother" } },
    ]);

    // The real path: db:migrate (applies only 0007) then db:seed.
    await runMigrations(url);
    await seed(url);
  }, 120_000);

  afterAll(async () => {
    await close();
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${dbName}`));
    await adminClose();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("retires the replaced fields and keeps every entry", async () => {
    const rows = await db.select().from(clinicalFieldDefinitions);
    const active = (code: string) => rows.find((r) => r.code === code)?.isActive;
    for (const code of ["past_medical_unknown", "impression", "recommendations", "stockings_measurements"]) {
      expect(active(code), code).toBe(false);
    }
    for (const code of ["family_history_unknown", "impression_1", "recommendation_8", "stockings_mid_calf"]) {
      expect(active(code), code).toBe(true);
    }
    const entries = await db.select().from(clinicalEntries).where(eq(clinicalEntries.visitId, ids.visit!));
    expect(entries).toHaveLength(4);
  });

  it("shows retired history read-only at the end of its tab; the new fields are live", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const a = await getClinicalSectionForVisit(db, actor, ids.visit!, ASSESSMENT_PLAN_SECTION_CODE);
    const last = a.fields.at(-1);
    expect(last?.code).toBe("impression");
    expect(last?.isActive).toBe(false);
    expect(last?.value.freeText).toBe("old impression");
    // retired fields without history on this visit are hidden
    expect(a.fields.find((f) => f.code === "recommendations")).toBeUndefined();
    expect(a.fields[0]?.code).toBe("impression_1");
    await expect(
      saveCurrent(db, actor, { visitId: ids.visit!, fieldId: ids.impression!, optionIds: [], freeText: "new" }),
    ).rejects.toBeInstanceOf(ClinicalFieldNotFoundError);
  });

  it("removes Family History from Subj only; its value stays visible in Past Medical Hx", async () => {
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const subj = await getClinicalSectionForVisit(db, actor, ids.visit!, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
    expect(subj.fields.map((f) => f.code)).not.toContain("family_history");
    expect(subj.fields.map((f) => f.code)).toContain("family_history_vv");
    const pmh = await getClinicalSectionForVisit(db, actor, ids.visit!, PAST_MEDICAL_HX_SECTION_CODE);
    expect(pmh.fields.find((f) => f.code === "family_history")?.value.freeText).toBe("mother");
    const unknown = pmh.fields.find((f) => f.code === "past_medical_unknown");
    expect(unknown?.isActive).toBe(false);
    expect(pmh.fields.at(-1)?.code).toBe("past_medical_unknown");
  });

  it("turns Additional Comments into a select with its own list; the old text is still the value", async () => {
    const [field] = await db
      .select()
      .from(clinicalFieldDefinitions)
      .where(eq(clinicalFieldDefinitions.code, "past_medical_additional_comments"));
    expect(field?.fieldType).toBe("select");
    const [list] = await db
      .select()
      .from(clinicalOptionLists)
      .where(eq(clinicalOptionLists.code, "past_medical_additional_comments"));
    expect(field?.optionListId).toBe(list?.id);
    const { actor } = await createTestUser(db, { roleCode: "DOCTOR" });
    const pmh = await getClinicalSectionForVisit(db, actor, ids.visit!, PAST_MEDICAL_HX_SECTION_CODE);
    expect(pmh.fields.find((f) => f.code === "past_medical_additional_comments")?.value.freeText).toBe("old note");
  });

  it("is idempotent: running its statements again changes nothing", async () => {
    const snapshot = async () => ({
      fields: await db.select().from(clinicalFieldDefinitions).orderBy(asc(clinicalFieldDefinitions.code)),
      placements: await db
        .select()
        .from(clinicalSectionFields)
        .orderBy(asc(clinicalSectionFields.sectionId), asc(clinicalSectionFields.fieldDefinitionId)),
      lists: await db.select().from(clinicalOptionLists).orderBy(asc(clinicalOptionLists.code)),
      sections: await db.select().from(clinicalSections).orderBy(asc(clinicalSections.code)),
    });
    const before = await snapshot();
    const file = readFileSync(path.resolve(process.cwd(), "drizzle", "0007_r1b_sonosoft_reconciliation.sql"), "utf8");
    for (const statement of file.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.execute(sql.raw(statement));
    }
    expect(await snapshot()).toEqual(before);
  });
});
