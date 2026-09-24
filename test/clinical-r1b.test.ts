import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditLogs,
  clinicalEntries,
  clinicalFieldDefinitions,
  clinicalOptionLists,
  clinicalOptions,
} from "@/db/schema";
import { seedClinicalDefinitions } from "@/db/seed";
import { handleSaveClinicalEntry, type ApiDeps } from "@/modules/clinical/api";
import {
  ASSESSMENT_PLAN_SECTION_CODE,
  assertFieldConfigConsistent,
  DEFAULT_CLINICAL_DEFINITIONS,
  ORDERED_LIST_CONFIG,
  PAST_MEDICAL_HX_SECTION_CODE,
  SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
} from "@/modules/clinical/definitions";
import {
  addClinicalOption,
  ClinicalConditionError,
  ClinicalFieldNotFoundError,
  getClinicalSectionForVisit,
  InvalidClinicalValueError,
  saveClinicalEntry,
  setClinicalOptionActive,
} from "@/modules/clinical/service";
import { createPatient, updatePatient, type PatientRecord } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, saveCurrent, uniqueSuffix } from "./helpers";

type Row = { optionId: string | null; freeText: string };
const row = (freeText: string, optionId: string | null = null): Row => ({ optionId, freeText });
const EMPTY: Row = row("");

describe("R1b definitions (pure)", () => {
  it("Subj Complaints Habits is grouped into the reviewed blocks, in order", () => {
    const subj = DEFAULT_CLINICAL_DEFINITIONS.sections.find(
      (s) => s.code === SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    );
    const groups = subj?.fieldCodes.map((c) => subj.groups?.[c]) ?? [];
    expect(groups.every((g) => typeof g === "string")).toBe(true);
    expect([...new Set(groups)]).toEqual([
      "Reason for visit / Problem List",
      "Chief Complaints",
      "Aggravating / Relieving Factors",
      "Previous conservative therapy",
      "Family history",
      "Habits",
      "Medications / Allergies",
    ]);
  });

  it("ordered lists have 8 rows; only Impression has a display mode", () => {
    expect(ORDERED_LIST_CONFIG).toEqual({
      impression_rows: { rows: 8, displayMode: true },
      recommendation_rows: { rows: 8, displayMode: false },
    });
  });

  it("per-field config must match the field types", () => {
    expect(() => assertFieldConfigConsistent(DEFAULT_CLINICAL_DEFINITIONS)).not.toThrow();
    const broken = {
      ...DEFAULT_CLINICAL_DEFINITIONS,
      fields: DEFAULT_CLINICAL_DEFINITIONS.fields.map((f) =>
        f.code === "stockings_mid_calf" ? { ...f, type: "textarea" as const } : f,
      ),
    };
    expect(() => assertFieldConfigConsistent(broken)).toThrow(/must be of type number/);
  });
});

describe("R1b clinical reconciliation (ADR-029)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let doctor: ActorContext;

  beforeAll(async () => {
    const opened = openTestDb();
    db = opened.db;
    close = opened.close;
    doctor = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
  });

  afterAll(async () => {
    await close();
  });

  async function newPatient(sex?: "F" | "M"): Promise<PatientRecord> {
    const s = uniqueSuffix();
    return createPatient(db, doctor, { firstName: `R1b-${s}`, lastName: `Clin-${s}`, sex });
  }

  async function newVisit(sex?: "F" | "M") {
    const patient = await newPatient(sex);
    const visit = await createVisit(db, doctor, { patientId: patient.id, reason: undefined });
    return { patient, visit };
  }

  async function field(code: string) {
    const [f] = await db
      .select()
      .from(clinicalFieldDefinitions)
      .where(eq(clinicalFieldDefinitions.code, code))
      .limit(1);
    if (!f) throw new Error(`field ${code} not seeded`);
    return f;
  }

  async function history(visitId: string, code: string) {
    return db
      .select({ version: clinicalEntries.version, value: clinicalEntries.value })
      .from(clinicalEntries)
      .where(and(eq(clinicalEntries.visitId, visitId), eq(clinicalEntries.fieldDefinitionId, (await field(code)).id)))
      .orderBy(asc(clinicalEntries.version));
  }

  async function view(visitId: string, section: string) {
    return getClinicalSectionForVisit(db, doctor, visitId, section);
  }

  async function saveRows(visitId: string, code: string, rows: Row[], display?: "bullets" | "numbers") {
    return saveCurrent(db, doctor, {
      visitId,
      fieldId: (await field(code)).id,
      optionIds: [],
      freeText: "",
      rows,
      ...(display ? { display } : {}),
    });
  }

  async function saveNumber(visitId: string, code: string, numberValue: number | null) {
    return saveCurrent(db, doctor, {
      visitId,
      fieldId: (await field(code)).id,
      optionIds: [],
      freeText: "",
      numberValue,
    });
  }

  describe("retired fields keep their history readable", () => {
    it("the seed retires the four replaced fields and never reactivates them", async () => {
      await seedClinicalDefinitions(db);
      for (const code of ["progression", "impression", "recommendations", "stockings_measurements"]) {
        expect((await field(code)).isActive, code).toBe(false);
      }
    });

    it("an old visit still shows its old Impression / measurements / progression values read-only; they cannot be edited", async () => {
      const { visit } = await newVisit();
      // Simulate entries written before R1b (the append-only table allows INSERT).
      const olds: [string, { optionIds: string[]; freeText: string }][] = [
        ["impression", { optionIds: [], freeText: "Old impression text" }],
        ["stockings_measurements", { optionIds: [], freeText: "Ankle 22 cm" }],
      ];
      for (const [code, value] of olds) {
        await db.insert(clinicalEntries).values({
          visitId: visit.id,
          fieldDefinitionId: (await field(code)).id,
          version: 1,
          value,
          createdBy: doctor.userId,
        });
      }

      const a = await view(visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      const imp = a.fields.find((f) => f.code === "impression");
      expect(imp).toMatchObject({ isActive: false, value: { freeText: "Old impression text" } });
      expect(a.fields.find((f) => f.code === "stockings_measurements")?.value.freeText).toBe("Ankle 22 cm");
      // Retired field stays next to its replacement, in the same group.
      const codes = a.fields.map((f) => f.code);
      expect(codes.indexOf("impression")).toBe(codes.indexOf("impression_rows") - 1);
      expect(imp?.groupLabel).toBe("Impression");

      await expect(
        saveClinicalEntry(db, doctor, {
          visitId: visit.id,
          fieldId: (await field("impression")).id,
          optionIds: [],
          freeText: "overwrite",
          expectedVersion: 1,
          clientMutationId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ClinicalFieldNotFoundError);
      expect((await history(visit.id, "impression")).map((r) => r.value.freeText)).toEqual([
        "Old impression text",
      ]);
    });

    it("the ordered rows reuse the retired fields' option lists (existing options stay available)", async () => {
      const [impList] = await db
        .select()
        .from(clinicalOptionLists)
        .where(eq(clinicalOptionLists.code, "impression"));
      expect((await field("impression_rows")).optionListId).toBe(impList?.id);
      expect((await field("impression")).optionListId).toBe(impList?.id);
      const [recList] = await db
        .select()
        .from(clinicalOptionLists)
        .where(eq(clinicalOptionLists.code, "recommendations"));
      expect((await field("recommendation_rows")).optionListId).toBe(recList?.id);
    });
  });

  describe("ordered Impression / Recommendation rows", () => {
    it("keeps row positions and order exactly (gaps kept, trailing empty rows dropped, never sorted)", async () => {
      const { visit } = await newVisit();
      const s = uniqueSuffix();
      const b = await addClinicalOption(db, doctor, { fieldId: (await field("impression_rows")).id, label: `B ${s}` });
      const a = await addClinicalOption(db, doctor, { fieldId: (await field("impression_rows")).id, label: `A ${s}` });

      const rows = [row("", b.id), EMPTY, row(" third  ", a.id), row("fourth"), EMPTY, EMPTY, EMPTY, EMPTY];
      const saved = await saveRows(visit.id, "impression_rows", rows);
      expect(saved.value).toEqual({
        optionIds: [],
        freeText: "",
        rows: [row("", b.id), EMPTY, row("third", a.id), row("fourth")],
      });

      const v = await view(visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      const f = v.fields.find((x) => x.code === "impression_rows");
      expect(f?.orderedList).toEqual({ rows: 8, displayMode: true });
      expect(f?.value.rows?.map((r) => r.optionId)).toEqual([b.id, null, a.id, null]);
    });

    it("Impression stores Bullets / Numbers per visit; changing only the mode is an audited revision", async () => {
      const { visit } = await newVisit();
      await saveRows(visit.id, "impression_rows", [row("CVI")]);
      const numbered = await saveRows(visit.id, "impression_rows", [row("CVI")], "numbers");
      expect(numbered).toMatchObject({ changed: true, version: 2 });
      expect(numbered.value.display).toBe("numbers");
      const back = await saveRows(visit.id, "impression_rows", [row("CVI")], "bullets");
      expect(back.value.display).toBeUndefined();
      expect((await history(visit.id, "impression_rows")).map((r) => r.version)).toEqual([1, 2, 3]);

      const audits = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.visitId, visit.id), eq(auditLogs.action, "clinical_entry.update")));
      expect(audits).toHaveLength(2);
      expect((audits[0]?.after as { value: { display?: string } }).value.display).toBe("numbers");

      // Other visits are unaffected (per visit).
      const other = await newVisit();
      const otherView = await view(other.visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      expect(otherView.fields.find((f) => f.code === "impression_rows")?.value.display).toBeUndefined();
    });

    it("Recommendations has no display mode; both lists reject more than 8 rows", async () => {
      const { visit } = await newVisit();
      await expect(saveRows(visit.id, "recommendation_rows", [row("x")], "numbers")).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
      const nine = Array.from({ length: 9 }, (_, i) => row(`r${i + 1}`));
      for (const code of ["impression_rows", "recommendation_rows"]) {
        await expect(saveRows(visit.id, code, nine)).rejects.toBeInstanceOf(InvalidClinicalValueError);
      }
      const eight = await saveRows(visit.id, "recommendation_rows", nine.slice(0, 8));
      expect(eight.value.rows).toHaveLength(8);
    });

    it("validates row options: own list only; a retired option may stay but not be newly chosen", async () => {
      const { visit } = await newVisit();
      const s = uniqueSuffix();
      const rec = await addClinicalOption(db, doctor, { fieldId: (await field("recommendation_rows")).id, label: `Rec ${s}` });
      const imp = await addClinicalOption(db, doctor, { fieldId: (await field("impression_rows")).id, label: `Imp ${s}` });

      await expect(saveRows(visit.id, "recommendation_rows", [row("", imp.id)])).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
      await saveRows(visit.id, "recommendation_rows", [row("", rec.id)]);

      const { actor: admin } = await createTestUser(db, { roleCode: "ADMIN" });
      await setClinicalOptionActive(db, admin, { optionId: rec.id, isActive: false });
      // Still selected (moved to row 2 with text added): allowed.
      const kept = await saveRows(visit.id, "recommendation_rows", [row("first"), row("", rec.id)]);
      expect(kept.value.rows?.[1]?.optionId).toBe(rec.id);
      // Newly chosen on another visit: refused.
      const other = await newVisit();
      await expect(saveRows(other.visit.id, "recommendation_rows", [row("", rec.id)])).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
    });

    it("rejects the wrong value shape: rows on other fields, plain options/text on ordered lists", async () => {
      const { visit } = await newVisit();
      await expect(saveRows(visit.id, "impression_init_venous_interp", [row("x")])).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
      await expect(
        saveCurrent(db, doctor, {
          visitId: visit.id,
          fieldId: (await field("impression_rows")).id,
          optionIds: [],
          freeText: "plain text",
        }),
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
    });

    it("a replayed ordered-list mutation writes nothing new; a different value under the same id is rejected", async () => {
      const { visit } = await newVisit();
      const fieldId = (await field("impression_rows")).id;
      const input = {
        visitId: visit.id,
        fieldId,
        optionIds: [] as string[],
        freeText: "",
        rows: [row("one"), row("two")],
        display: "numbers" as const,
        expectedVersion: 0,
        clientMutationId: randomUUID(),
      };
      await saveClinicalEntry(db, doctor, input);
      const replay = await saveClinicalEntry(db, doctor, input);
      expect(replay).toMatchObject({ replayed: true, changed: false, version: 1 });
      await expect(
        saveClinicalEntry(db, doctor, { ...input, rows: [row("two"), row("one")] }),
      ).rejects.toMatchObject({ name: "MutationIdReuseError" });
      expect(await history(visit.id, "impression_rows")).toHaveLength(1);
    });

    it("Impr for Init Venous Interp is a separate dynamic select with free text", async () => {
      const { visit } = await newVisit();
      const fid = (await field("impression_init_venous_interp")).id;
      const opt = await addClinicalOption(db, doctor, { fieldId: fid, label: `Init interp ${uniqueSuffix()}` });
      const saved = await saveCurrent(db, doctor, {
        visitId: visit.id,
        fieldId: fid,
        optionIds: [opt.id],
        freeText: "plus visit wording",
      });
      expect(saved.value).toEqual({ optionIds: [opt.id], freeText: "plus visit wording" });
      expect(await history(visit.id, "impression_rows")).toHaveLength(0);
    });
  });

  describe("structured stocking measurements (cm)", () => {
    it("stores numbers per field with one decimal, validates range, and clears", async () => {
      const { visit } = await newVisit();
      expect((await saveNumber(visit.id, "stockings_mid_thigh", 52.5)).value).toEqual({
        optionIds: [],
        freeText: "",
        numberValue: 52.5,
      });
      await saveNumber(visit.id, "stockings_floor_to_knee", 44);
      for (const bad of [-1, 300.5, 36.55]) {
        await expect(saveNumber(visit.id, "stockings_mid_calf", bad)).rejects.toBeInstanceOf(
          InvalidClinicalValueError,
        );
      }
      const cleared = await saveNumber(visit.id, "stockings_mid_thigh", null);
      expect(cleared).toMatchObject({ changed: true, version: 2, value: { optionIds: [], freeText: "" } });

      const v = await view(visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      const by = (code: string) => v.fields.find((f) => f.code === code);
      expect(by("stockings_floor_to_knee")?.value.numberValue).toBe(44);
      expect(by("stockings_mid_thigh")?.value.numberValue).toBeUndefined();
      expect(by("stockings_mid_calf")?.number).toEqual({ unit: "cm", min: 0, max: 300, decimals: 1 });
      expect(by("stockings_mid_calf")?.groupLabel).toBe("Stockings");
    });

    it("rejects text or options on a number field and a number on other fields", async () => {
      const { visit } = await newVisit();
      const numberId = (await field("stockings_mid_ankle")).id;
      await expect(
        saveCurrent(db, doctor, { visitId: visit.id, fieldId: numberId, optionIds: [], freeText: "22 cm" }),
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
      await expect(
        saveCurrent(db, doctor, {
          visitId: visit.id,
          fieldId: (await field("assessment_additional_comments")).id,
          optionIds: [],
          freeText: "",
          numberValue: 3,
        }),
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
    });
  });

  describe("Female-specific Past Medical Hx statement", () => {
    const code = "female_specific_statement";

    async function saveStatement(visitId: string, freeText: string) {
      return saveCurrent(db, doctor, { visitId, fieldId: (await field(code)).id, optionIds: [], freeText });
    }

    it("is shown 7th and saves (option + free text) for a Female patient", async () => {
      const { visit } = await newVisit("F");
      const pmh = await view(visit.id, PAST_MEDICAL_HX_SECTION_CODE);
      expect(pmh.fields.map((f) => f.code).at(-1)).toBe(code);
      expect(pmh.fields).toHaveLength(7);
      const opt = await addClinicalOption(db, doctor, { fieldId: (await field(code)).id, label: `Stmt ${uniqueSuffix()}` });
      const saved = await saveCurrent(db, doctor, {
        visitId: visit.id,
        fieldId: (await field(code)).id,
        optionIds: [opt.id],
        freeText: "visit note",
      });
      expect(saved.changed).toBe(true);
    });

    it("is hidden and refused on the server for Male or blank sex (nothing written, no audit)", async () => {
      for (const sex of ["M", undefined] as const) {
        const { visit } = await newVisit(sex);
        const pmh = await view(visit.id, PAST_MEDICAL_HX_SECTION_CODE);
        expect(pmh.fields.map((f) => f.code)).not.toContain(code);
        await expect(saveStatement(visit.id, "x")).rejects.toBeInstanceOf(ClinicalConditionError);
        expect(await history(visit.id, code)).toHaveLength(0);
        const audits = await db.select().from(auditLogs).where(eq(auditLogs.visitId, visit.id));
        expect(audits.filter((a) => a.entityType === "clinical_entry")).toHaveLength(0);
      }
    });

    it("keeps the value (read-only) when the patient's sex changes later; clearing is still allowed", async () => {
      const { patient, visit } = await newVisit("F");
      await saveStatement(visit.id, "recorded while female");
      await updatePatient(db, doctor, {
        id: patient.id,
        expectedVersion: patient.version,
        firstName: patient.firstName,
        lastName: patient.lastName,
        sex: "M",
      });

      const pmh = await view(visit.id, PAST_MEDICAL_HX_SECTION_CODE);
      const f = pmh.fields.find((x) => x.code === code);
      expect(f?.value.freeText).toBe("recorded while female");
      expect(f?.readOnlyReason).toMatch(/read-only/);

      await expect(saveStatement(visit.id, "changed")).rejects.toBeInstanceOf(ClinicalConditionError);
      expect((await history(visit.id, code)).map((r) => r.value.freeText)).toEqual(["recorded while female"]);
      // Clearing is allowed (a new version; history keeps v1).
      const cleared = await saveStatement(visit.id, "");
      expect(cleared).toMatchObject({ changed: true, version: 2 });
      expect(await history(visit.id, code)).toHaveLength(2);
    });

    it("the Route Handler maps the refusal to 409 condition_not_met", async () => {
      const { visit } = await newVisit("M");
      const ORIGIN = "http://localhost:3000";
      const deps: ApiDeps = { db, resolveActor: async () => doctor, appOrigin: null, allowRequestOrigin: true };
      const fid = (await field(code)).id;
      const res = await handleSaveClinicalEntry(
        new Request(`${ORIGIN}/api/visits/${visit.id}/clinical-entries/${fid}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({
            expectedUserId: doctor.userId,
            expectedVersion: 0,
            clientMutationId: randomUUID(),
            optionIds: [],
            freeText: "x",
          }),
        }),
        { visitId: visit.id, fieldId: fid },
        deps,
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("condition_not_met");
    });
  });

  describe("Subj Complaints Habits reconciliation", () => {
    it("groups the tab into visual blocks and relabels fields; progression is now a checkbox", async () => {
      const { visit } = await newVisit();
      const subj = await view(visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
      const by = (c: string) => subj.fields.find((f) => f.code === c);
      expect(by("characteristics")?.label).toBe("Associated condition");
      expect(by("duration")?.label).toBe("How long?");
      expect(by("chest_comments")?.label).toBe("Additional Comments");
      expect(by("family_history")?.label).toBe("Family history of VV?");
      expect(by("pain_meds")?.label).toBe("Pain Meds for CC");
      // The remaining §6.1 wording reuses the EXISTING fields (same concept, same history).
      expect(by("daily_activity_impact")?.label).toBe("Affects daily living activities?");
      expect(by("comments")?.label).toBe("Comment");
      expect(by("comments")?.id).not.toBe(by("chest_comments")?.id);
      expect(by("previous_conservative_therapy_duration")).toMatchObject({
        label: "How long?",
        groupLabel: "Previous conservative therapy",
      });
      expect(by("duration")?.groupLabel).toBe("Chief Complaints");
      expect(by("symptoms_worse_over_time")).toMatchObject({
        fieldType: "checkbox",
        label: "Symptoms getting worse over time?",
        groupLabel: "Chief Complaints",
      });
      expect(by("progression")).toBeUndefined();
      expect(by("alcohol")?.groupLabel).toBe("Habits");
      expect(by("allergies")?.groupLabel).toBe("Medications / Allergies");

      const saved = await saveCurrent(db, doctor, {
        visitId: visit.id,
        fieldId: (await field("symptoms_worse_over_time")).id,
        optionIds: [],
        freeText: "",
        checked: true,
      });
      expect(saved.value).toEqual({ optionIds: [], freeText: "", checked: true });
    });

    it("an old visit's progression value is still shown (read-only) in its old position", async () => {
      const { visit } = await newVisit();
      const s = uniqueSuffix();
      const prog = await field("progression");
      // The option list of a retired field still exists; insert the option directly.
      const [opt] = await db
        .insert(clinicalOptions)
        .values({ listId: prog.optionListId ?? "", label: `Worsening ${s}`, createdBy: doctor.userId })
        .returning();
      await db.insert(clinicalEntries).values({
        visitId: visit.id,
        fieldDefinitionId: prog.id,
        version: 1,
        value: { optionIds: [opt?.id ?? ""], freeText: "" },
        createdBy: doctor.userId,
      });
      const subj = await view(visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
      const codes = subj.fields.map((f) => f.code);
      expect(codes.indexOf("progression")).toBe(codes.indexOf("symptoms_worse_over_time") - 1);
      const p = subj.fields.find((f) => f.code === "progression");
      expect(p?.isActive).toBe(false);
      expect(p?.options.map((o) => o.label)).toContain(`Worsening ${s}`);
    });
  });
});
