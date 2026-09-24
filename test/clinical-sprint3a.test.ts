import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { auditLogs, clinicalEntries, clinicalFieldDefinitions, visits } from "@/db/schema";
import { seedClinicalDefinitions } from "@/db/seed";
import { handleSaveClinicalEntry, type ApiDeps } from "@/modules/clinical/api";
import {
  assertDefinitionsConsistent,
  assertExclusionRulesConsistent,
  ASSESSMENT_PLAN_FIELD_CODES,
  ASSESSMENT_PLAN_SECTION_CODE,
  DEFAULT_CLINICAL_DEFINITIONS,
  FIELD_EXCLUSION_RULES,
  FIELD_TYPES,
  optionListCodeFor,
  PAST_MEDICAL_HX_FIELD_CODES,
  PATIENT_CONDITION_RULES,
  PAST_MEDICAL_HX_SECTION_CODE,
  SUBJ_COMPLAINTS_HABITS_FIELD_CODES,
  SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
  type ClinicalDefinitions,
} from "@/modules/clinical/definitions";
import {
  addClinicalOption,
  ClinicalExclusionError,
  getClinicalSectionForVisit,
  InvalidClinicalValueError,
  listClinicalSections,
  saveClinicalEntry,
  VisitNotOpenError,
} from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import { ForbiddenError } from "@/modules/permissions/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, saveCurrent, uniqueSuffix } from "./helpers";

// "Subj Complaints Habits" as reconciled in R1b (ADR-029, FINAL_V1 §6.1): the
// visible fields of a new visit. The retired `progression` select is still placed
// (hidden unless a visit has history for it) and replaced by a checkbox.
const SUBJ_LABELS = [
  "Reason for Visit",
  "Problem List",
  "Chief Complaints",
  "Associated condition",
  "How long?",
  "Symptoms getting worse over time?",
  "Affects daily living activities?",
  "Additional Comments",
  "Comment",
  "Aggravating Factors",
  "Relieving Factors",
  "Previous Conservative Therapy",
  "How long?",
  "Family history of VV?",
  "Alcohol",
  "Exercise",
  "Tobacco",
  "Pain Meds for CC",
  "Current Meds",
  "Allergies",
];

/** Codes retired in R1b: still placed, hidden unless a visit has history for them. */
const RETIRED_CODES = ["progression", "impression", "recommendations", "stockings_measurements"];
const active = (codes: string[]) => codes.filter((c) => !RETIRED_CODES.includes(c));

// "Past Medical Hx" for a patient NOT recorded as Female: the female-specific
// statement (7th) is hidden (ADR-029; covered for Female patients in clinical-r1b.test.ts).
const PMH_LABELS = [
  "Past Medical Hx",
  "Family Medical Hx",
  "Unknown",
  "Prior Test Results",
  "Additional Comments",
  "Surgical Hx",
];

// "Assessment Plan+" as reconciled in R1b (ADR-029, FINAL_V1 §6.3), new visit.
const ASSESSMENT_LABELS = [
  "Impression",
  "Impr for Init Venous Interp",
  "Recommendations",
  "Stockings Type",
  "Stockings Compression",
  "Stockings Gender",
  "Stockings Color",
  "Mid Thigh",
  "Mid Calf",
  "Mid Ankle",
  "Floor to GF",
  "Floor to Knee",
  "Additional Comments",
];

const STOCKING_CODES = [
  "stockings_type",
  "stockings_compression",
  "stockings_gender",
  "stockings_color",
  "stockings_mid_thigh",
  "stockings_mid_calf",
  "stockings_mid_ankle",
  "stockings_floor_to_gf",
  "stockings_floor_to_knee",
];

describe("definitions (pure)", () => {
  it("every section places an explicit list; Subj is its 20 active fields plus the retired progression", () => {
    expect(SUBJ_COMPLAINTS_HABITS_FIELD_CODES).toHaveLength(21);
    expect(active(SUBJ_COMPLAINTS_HABITS_FIELD_CODES)).toHaveLength(20);
    const subj = DEFAULT_CLINICAL_DEFINITIONS.sections.find(
      (s) => s.code === SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
    );
    expect(subj?.fieldCodes).toEqual(SUBJ_COMPLAINTS_HABITS_FIELD_CODES);
    for (const code of [...PAST_MEDICAL_HX_FIELD_CODES, ...ASSESSMENT_PLAN_FIELD_CODES]) {
      if (code === "family_history") continue; // the one shared concept
      expect(SUBJ_COMPLAINTS_HABITS_FIELD_CODES).not.toContain(code);
    }
  });

  it("Family Medical Hx is family_history (shared), not a second field", () => {
    const codes = DEFAULT_CLINICAL_DEFINITIONS.fields.map((f) => f.code);
    expect(codes.filter((c) => c.includes("family"))).toEqual(["family_history"]);
    expect(PAST_MEDICAL_HX_FIELD_CODES).toContain("family_history");
    expect(SUBJ_COMPLAINTS_HABITS_FIELD_CODES).toContain("family_history");
  });

  it("the female-specific statement is the 7th Past Medical Hx field and applies to Female patients only (R1b)", () => {
    expect(PAST_MEDICAL_HX_FIELD_CODES[6]).toBe("female_specific_statement");
    const field = DEFAULT_CLINICAL_DEFINITIONS.fields.find((f) => f.code === "female_specific_statement");
    expect(field).toMatchObject({
      type: FIELD_TYPES.SELECT,
      label: "If FEMALE select the appropriate statement; otherwise disregard",
    });
    expect(PATIENT_CONDITION_RULES.map((r) => [r.field, r.patientSex])).toEqual([
      ["female_specific_statement", "F"],
    ]);
  });

  it("rejects a relabel of a field the section does not place, and an empty label", () => {
    const bad: ClinicalDefinitions = {
      fields: DEFAULT_CLINICAL_DEFINITIONS.fields,
      sections: [
        {
          code: "x",
          name: "X",
          sortOrder: 1,
          fieldCodes: ["comments"],
          labelOverrides: { allergies: "Allergy" },
        },
      ],
    };
    expect(() => assertDefinitionsConsistent(bad)).toThrow(/does not place/);
    const empty: ClinicalDefinitions = {
      fields: DEFAULT_CLINICAL_DEFINITIONS.fields,
      sections: [
        { code: "x", name: "X", sortOrder: 1, fieldCodes: ["comments"], labelOverrides: { comments: " " } },
      ],
    };
    expect(() => assertDefinitionsConsistent(empty)).toThrow(/empty label/);
  });

  it("exclusion rules must use a checkbox flag and known fields", () => {
    const defs = DEFAULT_CLINICAL_DEFINITIONS;
    expect(() => assertExclusionRulesConsistent(defs, FIELD_EXCLUSION_RULES)).not.toThrow();
    expect(() =>
      assertExclusionRulesConsistent(defs, [{ flag: "comments", excludes: ["allergies"] }]),
    ).toThrow(/checkbox/);
    expect(() =>
      assertExclusionRulesConsistent(defs, [{ flag: "past_medical_unknown", excludes: ["nope"] }]),
    ).toThrow(/unknown field/);
    expect(() =>
      assertExclusionRulesConsistent(defs, [{ flag: "past_medical_unknown", excludes: [] }]),
    ).toThrow(/excludes nothing/);
  });

  it("Unknown is a checkbox and only Past Medical Hx is excluded by it", () => {
    const unknown = DEFAULT_CLINICAL_DEFINITIONS.fields.find((f) => f.code === "past_medical_unknown");
    expect(unknown?.type).toBe(FIELD_TYPES.CHECKBOX);
    expect(FIELD_EXCLUSION_RULES).toEqual([
      { flag: "past_medical_unknown", excludes: ["past_medical_history"] },
    ]);
  });
});

describe("Sprint 3A clinical tabs: Past Medical Hx and Assessment Plan+", () => {
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
      firstName: `S3A-${s}`,
      lastName: `Tabs-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return createVisit(db, actor, { patientId: patient.id, reason: undefined });
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

  async function doctor() {
    return (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
  }

  async function view(actor: ActorContext, visitId: string, section: string) {
    return getClinicalSectionForVisit(db, actor, visitId, section);
  }

  async function history(visitId: string, code: string) {
    return db
      .select({ version: clinicalEntries.version, value: clinicalEntries.value })
      .from(clinicalEntries)
      .where(
        and(
          eq(clinicalEntries.visitId, visitId),
          eq(clinicalEntries.fieldDefinitionId, await fieldId(code)),
        ),
      )
      .orderBy(asc(clinicalEntries.version));
  }

  async function auditsFor(visitId: string) {
    return db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.visitId, visitId), eq(auditLogs.entityType, "clinical_entry")))
      .orderBy(asc(auditLogs.id));
  }

  async function option(actor: ActorContext, code: string, label: string) {
    return addClinicalOption(db, actor, { fieldId: await fieldId(code), label });
  }

  describe("tabs and exact field order", () => {
    it("lists the tabs in docs order, from data, for actors with clinical.read only", async () => {
      const d = await doctor();
      const known = [
        SUBJ_COMPLAINTS_HABITS_SECTION_CODE,
        PAST_MEDICAL_HX_SECTION_CODE,
        ASSESSMENT_PLAN_SECTION_CODE,
      ];
      const tabs = await listClinicalSections(db, d);
      expect(tabs.map((t) => t.code).filter((c) => known.includes(c))).toEqual(known);
      expect(tabs.filter((t) => known.includes(t.code)).map((t) => t.name)).toEqual([
        "Subj Complaints Habits",
        "Past Medical Hx",
        "Assessment Plan+",
      ]);

      const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });
      await expect(listClinicalSections(db, reception)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("Subj Complaints Habits (R1b): the 20 active fields, in order, with the SonoSoft labels", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const subj = await view(d, visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
      expect(subj.fields.map((f) => f.label)).toEqual(SUBJ_LABELS);
      expect(subj.fields.map((f) => f.code)).toEqual(active(SUBJ_COMPLAINTS_HABITS_FIELD_CODES));
    });

    it("Past Medical Hx and Assessment Plan+ have exactly the documented fields, in order", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const pmh = await view(d, visit.id, PAST_MEDICAL_HX_SECTION_CODE);
      expect(pmh.fields.map((f) => f.label)).toEqual(PMH_LABELS);
      expect(pmh.fields.map((f) => f.code)).toEqual(
        PAST_MEDICAL_HX_FIELD_CODES.filter((c) => c !== "female_specific_statement"),
      );
      const assessment = await view(d, visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      expect(assessment.fields.map((f) => f.label)).toEqual(ASSESSMENT_LABELS);
      expect(assessment.fields.map((f) => f.code)).toEqual(active(ASSESSMENT_PLAN_FIELD_CODES));
    });

    it("field types: Unknown is a checkbox; ordered rows; Stockings are single-selects plus numbers", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const pmh = await view(d, visit.id, PAST_MEDICAL_HX_SECTION_CODE);
      const type = (code: string) => pmh.fields.find((f) => f.code === code)?.fieldType;
      expect(type("past_medical_unknown")).toBe("checkbox");
      expect(type("past_medical_history")).toBe("multiselect");
      expect(type("surgical_history")).toBe("multiselect");
      expect(type("prior_test_results")).toBe("textarea");

      const a = await view(d, visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      const at = (code: string) => a.fields.find((f) => f.code === code)?.fieldType;
      expect(at("impression_rows")).toBe("ordered_list");
      expect(at("recommendation_rows")).toBe("ordered_list");
      expect(at("impression_init_venous_interp")).toBe("select");
      for (const code of ["stockings_type", "stockings_compression", "stockings_gender", "stockings_color"]) {
        expect(at(code)).toBe("select");
      }
      for (const code of STOCKING_CODES.slice(4)) expect(at(code), code).toBe("number");
      for (const code of RETIRED_CODES) expect(at(code), code).toBeUndefined();
    });

    it("the seed creates option lists for the new choice fields but no option VALUES (dynamic lists only)", async () => {
      const choice = DEFAULT_CLINICAL_DEFINITIONS.fields.filter(
        (f) =>
          active([...PAST_MEDICAL_HX_FIELD_CODES, ...ASSESSMENT_PLAN_FIELD_CODES]).includes(f.code) &&
          optionListCodeFor(f) !== null,
      );
      expect(choice.map((f) => f.code).sort()).toEqual(
        [
          "family_history",
          "female_specific_statement",
          "impression_init_venous_interp",
          "impression_rows",
          "past_medical_history",
          "recommendation_rows",
          "stockings_color",
          "stockings_compression",
          "stockings_gender",
          "stockings_type",
          "surgical_history",
        ].sort(),
      );
      for (const f of choice) {
        const lists = await db.execute<{ id: string }>(
          sql`SELECT id FROM clinical_option_lists WHERE code = ${optionListCodeFor(f)}`,
        );
        expect(lists.rows, f.code).toHaveLength(1);
        // Options only ever come from "+ Add New" (created_by is always set); the seed writes none.
        const seeded = await db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM clinical_options WHERE list_id = ${lists.rows[0]?.id} AND created_by IS NULL`,
        );
        expect(Number(seeded.rows[0]?.n), f.code).toBe(0);
      }
    });

    it("new field codes are unique in the database", async () => {
      const codes = [...PAST_MEDICAL_HX_FIELD_CODES, ...ASSESSMENT_PLAN_FIELD_CODES];
      for (const code of new Set(codes)) {
        const rows = await db
          .select({ id: clinicalFieldDefinitions.id })
          .from(clinicalFieldDefinitions)
          .where(eq(clinicalFieldDefinitions.code, code));
        expect(rows, code).toHaveLength(1);
      }
    });
  });

  describe("Family Medical Hx shares family_history (one source of truth)", () => {
    it("same field, one version stream, shown as 'Family Medical Hx' here and 'Family history of VV?' in Subj", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const fid = await fieldId("family_history");
      const opt = await option(d, "family_history", `Father DVT ${uniqueSuffix()}`);

      await saveCurrent(db, d, { visitId: visit.id, fieldId: fid, optionIds: [opt.id], freeText: "" });

      const subj = await view(d, visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
      const pmh = await view(d, visit.id, PAST_MEDICAL_HX_SECTION_CODE);
      const inSubj = subj.fields.find((f) => f.code === "family_history");
      const inPmh = pmh.fields.find((f) => f.code === "family_history");
      expect(inSubj?.label).toBe("Family history of VV?");
      expect(inPmh?.label).toBe("Family Medical Hx");
      expect(inPmh?.id).toBe(inSubj?.id);
      expect(inPmh?.version).toBe(1);
      expect(inPmh?.value).toEqual(inSubj?.value);
      expect(inPmh?.options.map((o) => o.id)).toEqual(inSubj?.options.map((o) => o.id));

      // Editing "from the other tab" continues the SAME stream (v2), no second field.
      await saveCurrent(db, d, { visitId: visit.id, fieldId: fid, optionIds: [], freeText: "none known" });
      expect((await history(visit.id, "family_history")).map((r) => r.version)).toEqual([1, 2]);
      const again = await view(d, visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
      expect(again.fields.find((f) => f.code === "family_history")?.value.freeText).toBe("none known");
    });
  });

  describe("persistence, option lists and free text", () => {
    it("Impression and Recommendations: reusable dynamic options plus visit-only free text, separate lists", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const s = uniqueSuffix();
      const imp = await option(d, "impression_rows", `Varicose veins ${s}`);
      const rec = await option(d, "recommendation_rows", `Compression ${s}`);

      const a = await view(d, visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      const impField = a.fields.find((f) => f.code === "impression_rows");
      const recField = a.fields.find((f) => f.code === "recommendation_rows");
      // lists are independent: one field's option never leaks into the other
      expect(impField?.options.map((o) => o.id)).toContain(imp.id);
      expect(impField?.options.map((o) => o.id)).not.toContain(rec.id);
      expect(recField?.options.map((o) => o.id)).toContain(rec.id);
      expect(recField?.options.map((o) => o.id)).not.toContain(imp.id);

      await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: await fieldId("impression_rows"),
        optionIds: [],
        freeText: "",
        rows: [{ optionId: imp.id, freeText: `visit-only wording ${s}` }],
      });
      const after = await view(d, visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      const saved = after.fields.find((f) => f.code === "impression_rows");
      expect(saved?.value).toEqual({
        optionIds: [],
        freeText: "",
        rows: [{ optionId: imp.id, freeText: `visit-only wording ${s}` }],
      });
      // the free text never became a permanent option
      expect(saved?.options.map((o) => o.label)).not.toContain(`visit-only wording ${s}`);
    });

    it("textareas round-trip (Prior Test Results, both Additional Comments are separate fields)", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: await fieldId("prior_test_results"),
        optionIds: [],
        freeText: "Duplex 2024: normal",
      });
      await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: await fieldId("past_medical_additional_comments"),
        optionIds: [],
        freeText: "PMH comment",
      });
      await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: await fieldId("assessment_additional_comments"),
        optionIds: [],
        freeText: "Assessment comment",
      });
      const pmh = await view(d, visit.id, PAST_MEDICAL_HX_SECTION_CODE);
      const a = await view(d, visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      const text = (v: typeof pmh, code: string) => v.fields.find((f) => f.code === code)?.value.freeText;
      expect(text(pmh, "prior_test_results")).toBe("Duplex 2024: normal");
      expect(text(pmh, "past_medical_additional_comments")).toBe("PMH comment");
      expect(text(a, "assessment_additional_comments")).toBe("Assessment comment");
      expect(text(pmh, "assessment_additional_comments")).toBeUndefined();
    });

    it("Stockings fields are independent: saving one creates no revision or audit row for the others", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const type = await option(d, "stockings_type", `Knee-high ${uniqueSuffix()}`);

      await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: await fieldId("stockings_type"),
        optionIds: [type.id],
        freeText: "",
      });
      await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: await fieldId("stockings_mid_calf"),
        optionIds: [],
        freeText: "",
        numberValue: 36,
      });

      const a = await view(d, visit.id, ASSESSMENT_PLAN_SECTION_CODE);
      const by = (code: string) => a.fields.find((f) => f.code === code);
      expect(by("stockings_type")?.version).toBe(1);
      expect(by("stockings_mid_calf")?.version).toBe(1);
      expect(by("stockings_mid_calf")?.value.numberValue).toBe(36);
      for (const code of STOCKING_CODES.filter((c) => c !== "stockings_type" && c !== "stockings_mid_calf")) {
        expect(by(code)?.version, code).toBe(0);
        expect(by(code)?.value, code).toEqual({ optionIds: [], freeText: "" });
      }
      // Each field has its own history and its own audit trail; nothing demographic is copied in.
      const audits = await auditsFor(visit.id);
      expect(audits.map((r) => (r.metadata as { fieldCode: string }).fieldCode).sort()).toEqual(
        ["stockings_mid_calf", "stockings_type"],
      );
      for (const code of STOCKING_CODES) {
        expect((await history(visit.id, code)).length, code).toBe(
          code === "stockings_type" || code === "stockings_mid_calf" ? 1 : 0,
        );
      }
    });

    it("a stocking select accepts a single option only", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const s = uniqueSuffix();
      const a = await option(d, "stockings_color", `Beige ${s}`);
      const b = await option(d, "stockings_color", `Black ${s}`);
      await expect(
        saveCurrent(db, d, {
          visitId: visit.id,
          fieldId: await fieldId("stockings_color"),
          optionIds: [a.id, b.id],
          freeText: "",
        }),
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
    });
  });

  describe('"Unknown" is exclusive with Past Medical Hx values', () => {
    async function setup() {
      const d = await doctor();
      const visit = await newVisit(d);
      const pmhOpt = await option(d, "past_medical_history", `Hypertension ${uniqueSuffix()}`);
      return {
        d,
        visit,
        pmhOpt,
        unknownId: await fieldId("past_medical_unknown"),
        pmhId: await fieldId("past_medical_history"),
      };
    }

    it("Unknown stores an auditable checked value, in its own version stream", async () => {
      const { d, visit, unknownId } = await setup();
      const first = await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: unknownId,
        optionIds: [],
        freeText: "",
        checked: true,
      });
      expect(first).toMatchObject({ changed: true, version: 1, value: { checked: true } });
      const second = await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: unknownId,
        optionIds: [],
        freeText: "",
        checked: false,
      });
      expect(second).toMatchObject({ changed: true, version: 2, value: { checked: false } });

      expect((await history(visit.id, "past_medical_unknown")).map((r) => r.value.checked)).toEqual([
        true,
        false,
      ]);
      const audits = await auditsFor(visit.id);
      expect(audits.map((a) => a.action)).toEqual(["clinical_entry.create", "clinical_entry.update"]);
      expect(audits[1]?.before).toMatchObject({ version: 1, value: { checked: true } });
      expect(audits[1]?.after).toMatchObject({ version: 2, value: { checked: false } });
    });

    it("cannot be checked while Past Medical Hx has options or free text; nothing is written", async () => {
      const { d, visit, pmhOpt, unknownId, pmhId } = await setup();
      await saveCurrent(db, d, { visitId: visit.id, fieldId: pmhId, optionIds: [pmhOpt.id], freeText: "" });
      const before = await auditsFor(visit.id);

      await expect(
        saveCurrent(db, d, { visitId: visit.id, fieldId: unknownId, optionIds: [], freeText: "", checked: true }),
      ).rejects.toBeInstanceOf(ClinicalExclusionError);
      expect(await history(visit.id, "past_medical_unknown")).toHaveLength(0);
      expect(await auditsFor(visit.id)).toHaveLength(before.length);

      // free text alone counts as a value too
      await saveCurrent(db, d, { visitId: visit.id, fieldId: pmhId, optionIds: [], freeText: "asthma" });
      await expect(
        saveCurrent(db, d, { visitId: visit.id, fieldId: unknownId, optionIds: [], freeText: "", checked: true }),
      ).rejects.toBeInstanceOf(ClinicalExclusionError);

      // clearing Past Medical Hx first makes it possible (explicit user action, both audited)
      await saveCurrent(db, d, { visitId: visit.id, fieldId: pmhId, optionIds: [], freeText: "" });
      const ok = await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: unknownId,
        optionIds: [],
        freeText: "",
        checked: true,
      });
      expect(ok.changed).toBe(true);
    });

    it("Past Medical Hx cannot get values while Unknown is checked; unchecking re-enables it", async () => {
      const { d, visit, pmhOpt, unknownId, pmhId } = await setup();
      await saveCurrent(db, d, { visitId: visit.id, fieldId: unknownId, optionIds: [], freeText: "", checked: true });

      await expect(
        saveCurrent(db, d, { visitId: visit.id, fieldId: pmhId, optionIds: [pmhOpt.id], freeText: "" }),
      ).rejects.toBeInstanceOf(ClinicalExclusionError);
      await expect(
        saveCurrent(db, d, { visitId: visit.id, fieldId: pmhId, optionIds: [], freeText: "diabetes" }),
      ).rejects.toBeInstanceOf(ClinicalExclusionError);
      expect(await history(visit.id, "past_medical_history")).toHaveLength(0);

      // Clearing (an empty value) is never refused, and other tabs' fields are unaffected.
      await saveCurrent(db, d, { visitId: visit.id, fieldId: unknownId, optionIds: [], freeText: "", checked: false });
      const ok = await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: pmhId,
        optionIds: [pmhOpt.id],
        freeText: "",
      });
      expect(ok).toMatchObject({ changed: true, version: 1 });
    });

    it("only Past Medical Hx is excluded: Family Medical Hx, Surgical Hx and the notes still work with Unknown checked", async () => {
      const { d, visit, unknownId } = await setup();
      await saveCurrent(db, d, { visitId: visit.id, fieldId: unknownId, optionIds: [], freeText: "", checked: true });
      for (const code of ["family_history", "surgical_history", "prior_test_results", "past_medical_additional_comments"]) {
        const r = await saveCurrent(db, d, {
          visitId: visit.id,
          fieldId: await fieldId(code),
          optionIds: [],
          freeText: `note for ${code}`,
        });
        expect(r.changed, code).toBe(true);
      }
    });

    it("exclusion is per visit", async () => {
      const { d, visit, unknownId } = await setup();
      const other = await newVisit(d);
      await saveCurrent(db, d, { visitId: visit.id, fieldId: unknownId, optionIds: [], freeText: "", checked: true });
      const r = await saveCurrent(db, d, {
        visitId: other.id,
        fieldId: await fieldId("past_medical_history"),
        optionIds: [],
        freeText: "fine on another visit",
      });
      expect(r.changed).toBe(true);
    });

    it("an already-inconsistent pair can always be resolved (no deadlock)", async () => {
      const { d, visit, pmhOpt, unknownId, pmhId } = await setup();
      // Data that predates the rule / a race: both present. Rows are append-only INSERTs.
      await db.insert(clinicalEntries).values([
        {
          visitId: visit.id,
          fieldDefinitionId: unknownId,
          version: 1,
          value: { optionIds: [], freeText: "", checked: true },
          createdBy: d.userId,
        },
        {
          visitId: visit.id,
          fieldDefinitionId: pmhId,
          version: 1,
          value: { optionIds: [pmhOpt.id], freeText: "" },
          createdBy: d.userId,
        },
      ]);
      // Clearing either side is allowed even though the other still holds a value.
      const cleared = await saveCurrent(db, d, { visitId: visit.id, fieldId: pmhId, optionIds: [], freeText: "" });
      expect(cleared.changed).toBe(true);
      // and a no-op save never fails on old state
      const noop = await saveCurrent(db, d, { visitId: visit.id, fieldId: unknownId, optionIds: [], freeText: "", checked: true });
      expect(noop.changed).toBe(false);
    });

    it("concurrent Unknown and Past Medical Hx saves on one visit cannot both succeed", async () => {
      const { d, visit, pmhOpt, unknownId, pmhId } = await setup();
      const results = await Promise.allSettled([
        saveCurrent(db, d, { visitId: visit.id, fieldId: unknownId, optionIds: [], freeText: "", checked: true }),
        saveCurrent(db, d, { visitId: visit.id, fieldId: pmhId, optionIds: [pmhOpt.id], freeText: "" }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ClinicalExclusionError);
      const unknownRows = await history(visit.id, "past_medical_unknown");
      const pmhRows = await history(visit.id, "past_medical_history");
      expect(unknownRows.length + pmhRows.length).toBe(1);
    });

    it("the checkbox value is validated: needs checked, takes no options or text; others reject checked", async () => {
      const { d, visit, unknownId } = await setup();
      const save = (fid: string, extra: { optionIds?: string[]; freeText?: string; checked?: boolean }) =>
        saveCurrent(db, d, { visitId: visit.id, fieldId: fid, optionIds: [], freeText: "", ...extra });

      await expect(save(unknownId, {})).rejects.toBeInstanceOf(InvalidClinicalValueError);
      await expect(save(unknownId, { checked: true, freeText: "x" })).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
      await expect(
        save(unknownId, { checked: true, optionIds: [randomUUID()] }),
      ).rejects.toBeInstanceOf(InvalidClinicalValueError);
      await expect(save(await fieldId("prior_test_results"), { checked: false })).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
      await expect(save(await fieldId("impression_init_venous_interp"), { checked: true })).rejects.toBeInstanceOf(
        InvalidClinicalValueError,
      );
      expect(await history(visit.id, "past_medical_unknown")).toHaveLength(0);
    });

    it("unchecking an empty Unknown is a no-op; a replayed mutation writes nothing new", async () => {
      const { d, visit, unknownId } = await setup();
      const noop = await saveCurrent(db, d, {
        visitId: visit.id,
        fieldId: unknownId,
        optionIds: [],
        freeText: "",
        checked: false,
      });
      expect(noop.changed).toBe(false);
      expect(await history(visit.id, "past_medical_unknown")).toHaveLength(0);

      const id = randomUUID();
      const input = {
        visitId: visit.id,
        fieldId: unknownId,
        optionIds: [] as string[],
        freeText: "",
        checked: true,
        expectedVersion: 0,
        clientMutationId: id,
      };
      const first = await saveClinicalEntry(db, d, input);
      const replay = await saveClinicalEntry(db, d, input);
      expect(first.changed).toBe(true);
      expect(replay).toMatchObject({ changed: false, replayed: true, version: 1 });
      expect(await history(visit.id, "past_medical_unknown")).toHaveLength(1);
    });
  });

  describe("permissions and visit lock (existing rules on the new tabs)", () => {
    it("Nurse/Assistant writes visit-only text and checks Unknown but cannot add permanent options", async () => {
      const { actor: nurse } = await createTestUser(db, { roleCode: "NURSE_ASSISTANT" });
      const visit = await newVisit(await doctor());
      const ok = await saveCurrent(db, nurse, {
        visitId: visit.id,
        fieldId: await fieldId("impression_init_venous_interp"),
        optionIds: [],
        freeText: "nurse wording",
      });
      expect(ok.changed).toBe(true);
      const unknown = await saveCurrent(db, nurse, {
        visitId: visit.id,
        fieldId: await fieldId("past_medical_unknown"),
        optionIds: [],
        freeText: "",
        checked: true,
      });
      expect(unknown.changed).toBe(true);
      await expect(option(nurse, "stockings_color", `Nope ${uniqueSuffix()}`)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it("Admin can read the new tabs but not write; Reception has no clinical access at all", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const { actor: admin } = await createTestUser(db, { roleCode: "ADMIN" });
      const { actor: reception } = await createTestUser(db, { roleCode: "RECEPTION" });

      expect((await view(admin, visit.id, PAST_MEDICAL_HX_SECTION_CODE)).fields).toHaveLength(6);
      await expect(
        saveCurrent(db, admin, {
          visitId: visit.id,
          fieldId: await fieldId("past_medical_unknown"),
          optionIds: [],
          freeText: "",
          checked: true,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(view(reception, visit.id, ASSESSMENT_PLAN_SECTION_CODE)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect(await history(visit.id, "past_medical_unknown")).toHaveLength(0);
    });

    it("a visit that is not open rejects writes to the new fields", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      await db.update(visits).set({ status: "closed" }).where(eq(visits.id, visit.id));
      for (const [code, extra] of [
        ["impression_rows", { rows: [{ optionId: null, freeText: "x" }] }],
        ["stockings_mid_calf", { numberValue: 30 }],
        ["past_medical_unknown", { checked: true }],
      ] as const) {
        await expect(
          saveCurrent(db, d, { visitId: visit.id, fieldId: await fieldId(code), optionIds: [], freeText: "", ...extra }),
        ).rejects.toBeInstanceOf(VisitNotOpenError);
      }
    });

    it("optimistic concurrency applies to the new fields (stale version is a conflict, nothing written)", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const fid = await fieldId("impression_init_venous_interp");
      await saveCurrent(db, d, { visitId: visit.id, fieldId: fid, optionIds: [], freeText: "v1" });
      await expect(
        saveClinicalEntry(db, d, {
          visitId: visit.id,
          fieldId: fid,
          optionIds: [],
          freeText: "stale",
          expectedVersion: 0,
          clientMutationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ name: "ClinicalConflictError" });
      expect((await history(visit.id, "impression_init_venous_interp")).map((r) => r.value.freeText)).toEqual(["v1"]);
    });
  });

  describe("Route Handler", () => {
    const ORIGIN = "http://localhost:3000";
    const depsFor = (actor: ActorContext): ApiDeps => ({
      db,
      resolveActor: async () => actor,
      appOrigin: null,
      allowRequestOrigin: true,
    });
    async function post(actor: ActorContext, visitId: string, fid: string, body: Record<string, unknown>) {
      const req = new Request(`${ORIGIN}/api/visits/${visitId}/clinical-entries/${fid}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          expectedUserId: actor.userId,
          expectedVersion: 0,
          clientMutationId: randomUUID(),
          optionIds: [],
          freeText: "",
          ...body,
        }),
      });
      const res = await handleSaveClinicalEntry(req, { visitId, fieldId: fid }, depsFor(actor));
      return { status: res.status, json: (await res.json()) as { error?: string; value?: unknown } };
    }

    it("maps the exclusion to 409 exclusive_value (not a version conflict) and writes nothing", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const unknownId = await fieldId("past_medical_unknown");
      const pmhId = await fieldId("past_medical_history");

      const checked = await post(d, visit.id, unknownId, { checked: true });
      expect(checked.status).toBe(200);
      expect(checked.json.value).toMatchObject({ checked: true });

      const refused = await post(d, visit.id, pmhId, { freeText: "hypertension" });
      expect(refused.status).toBe(409);
      expect(refused.json.error).toBe("exclusive_value");
      expect(await history(visit.id, "past_medical_history")).toHaveLength(0);
    });

    it("rejects `checked` on a non-checkbox field (400) and a non-boolean checked (400)", async () => {
      const d = await doctor();
      const visit = await newVisit(d);
      const onText = await post(d, visit.id, await fieldId("impression_init_venous_interp"), { checked: true });
      expect(onText.status).toBe(400);
      const wrongType = await post(d, visit.id, await fieldId("past_medical_unknown"), { checked: "yes" });
      expect(wrongType.status).toBe(400);
      expect(wrongType.json.error).toBe("invalid_input");
    });
  });

  describe("seed: presentation labels are cosmetic and non-destructive", () => {
    it("re-seeding is idempotent, and changing a label override touches no field, list or entry", async () => {
      const counts = async () => {
        const one = async (t: string) =>
          Number((await db.execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${t}`))).rows[0]?.n);
        return {
          fields: await one("clinical_field_definitions"),
          lists: await one("clinical_option_lists"),
          placements: await one("clinical_section_fields"),
          entries: await one("clinical_entries"),
        };
      };
      await seedClinicalDefinitions(db);
      const before = await counts();
      await seedClinicalDefinitions(db);
      expect(await counts()).toEqual(before);

      const relabelled: ClinicalDefinitions = {
        fields: DEFAULT_CLINICAL_DEFINITIONS.fields,
        sections: DEFAULT_CLINICAL_DEFINITIONS.sections.map((s) =>
          s.code === PAST_MEDICAL_HX_SECTION_CODE
            ? { ...s, labelOverrides: { family_history: "Family Medical History" } }
            : s,
        ),
      };
      const d = await doctor();
      const visit = await newVisit(d);
      try {
        await seedClinicalDefinitions(db, relabelled);
        const pmh = await view(d, visit.id, PAST_MEDICAL_HX_SECTION_CODE);
        expect(pmh.fields.find((f) => f.code === "family_history")?.label).toBe("Family Medical History");
        const subj = await view(d, visit.id, SUBJ_COMPLAINTS_HABITS_SECTION_CODE);
        expect(subj.fields.find((f) => f.code === "family_history")?.label).toBe("Family history of VV?");
        expect(await counts()).toEqual(before);
      } finally {
        await seedClinicalDefinitions(db);
      }
      const restored = await view(d, visit.id, PAST_MEDICAL_HX_SECTION_CODE);
      expect(restored.fields.find((f) => f.code === "family_history")?.label).toBe("Family Medical Hx");
    });
  });
});
