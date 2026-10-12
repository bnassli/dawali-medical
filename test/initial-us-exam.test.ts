import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { clinicalFieldDefinitions } from "@/db/schema";
import {
  CLINICAL_SECTIONS,
  FIXED_CHOICES,
  INITIAL_US_EXAM_FIELD_CODES,
  INITIAL_US_EXAM_SECTION_CODE,
  NUMERIC_FIELD_RULES,
} from "@/modules/clinical/definitions";
import { layoutFieldCodes, SECTION_LAYOUTS } from "@/modules/clinical/layouts";
import {
  getClinicalSectionForVisit,
  InvalidClinicalValueError,
  listClinicalSections,
  saveClinicalEntry,
} from "@/modules/clinical/service";
import { createPatient } from "@/modules/patients/service";
import type { ActorContext } from "@/modules/permissions/types";
import { createVisit } from "@/modules/visits/service";
import { createTestUser, openTestDb, uniqueSuffix } from "./helpers";

describe("Initial US Exam tab (ADR-041)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let doctor: ActorContext;

  beforeAll(async () => {
    ({ db, close } = openTestDb());
    doctor = (await createTestUser(db, { roleCode: "DOCTOR" })).actor;
  });
  afterAll(async () => close());

  async function visitId() {
    const s = uniqueSuffix();
    const p = await createPatient(db, doctor, {
      firstName: `IUS-${s}`,
      lastName: `Tab-${s}`,
      middleName: undefined,
      dateOfBirth: undefined,
      sex: undefined,
      phone: undefined,
      email: undefined,
      icareFileNo: undefined,
    });
    return (await createVisit(db, doctor, { patientId: p.id, reason: undefined })).id;
  }

  async function fieldId(code: string) {
    const [row] = await db.select().from(clinicalFieldDefinitions).where(eq(clinicalFieldDefinitions.code, code));
    return row!.id;
  }

  const save = async (visit: string, code: string, value: { freeText?: string; checked?: boolean }) =>
    saveClinicalEntry(db, doctor, {
      visitId: visit,
      fieldId: await fieldId(code),
      optionIds: [],
      freeText: value.freeText ?? "",
      ...(value.checked === undefined ? {} : { checked: value.checked }),
      expectedVersion: 0,
      clientMutationId: randomUUID(),
    });

  it("follows SonoSoft's Workup order: after Past Medical Hx, before Assessment Plan+", async () => {
    const order = CLINICAL_SECTIONS.map((s) => s.code);
    expect(order.indexOf(INITIAL_US_EXAM_SECTION_CODE)).toBe(order.indexOf("past_medical_hx") + 1);
    expect(order.indexOf("assessment_plan")).toBe(order.indexOf(INITIAL_US_EXAM_SECTION_CODE) + 1);
    expect(new Set(CLINICAL_SECTIONS.map((s) => s.sortOrder)).size).toBe(CLINICAL_SECTIONS.length);

    const ours = ["past_medical_hx", INITIAL_US_EXAM_SECTION_CODE, "assessment_plan"];
    const live = (await listClinicalSections(db, doctor)).map((t) => t.code).filter((c) => ours.includes(c));
    expect(live).toEqual(ours);
  });

  it("places both legs mirrored, the middle column and the findings, every field on the layout", async () => {
    const view = await getClinicalSectionForVisit(db, doctor, await visitId(), INITIAL_US_EXAM_SECTION_CODE);
    expect(view.fields.map((f) => f.code)).toEqual(INITIAL_US_EXAM_FIELD_CODES);
    const right = INITIAL_US_EXAM_FIELD_CODES.filter((c) => c.startsWith("ius_r_"));
    const left = INITIAL_US_EXAM_FIELD_CODES.filter((c) => c.startsWith("ius_l_"));
    expect(right).toHaveLength(20);
    expect(left.map((c) => c.replace("ius_l_", ""))).toEqual(right.map((c) => c.replace("ius_r_", "")));
    expect(layoutFieldCodes(SECTION_LAYOUTS[INITIAL_US_EXAM_SECTION_CODE]!)).toEqual(INITIAL_US_EXAM_FIELD_CODES);
    // Every choice field has its fixed values, every number field its rule.
    for (const f of view.fields) {
      if (f.fieldType === "choice") expect(FIXED_CHOICES[f.code]?.length).toBeGreaterThan(0);
      if (f.fieldType === "number") expect(NUMERIC_FIELD_RULES[f.code]?.unit).toBe("mm");
    }
    // The ultrasound fields of Post EVLT Comp Follow Up are separate fields.
    expect(INITIAL_US_EXAM_FIELD_CODES.some((c) => c.startsWith("us_"))).toBe(false);
  });

  it("saves vein status, diameter, a perforator box and the DVT statement; refuses values outside the rules", async () => {
    const visit = await visitId();
    expect((await save(visit, "ius_r_gsv_status", { freeText: "incompetent" })).entry?.value.freeText).toBe("incompetent");
    expect((await save(visit, "ius_l_gsv_size_knee", { freeText: "6.5" })).entry?.value.freeText).toBe("6.5");
    expect((await save(visit, "ius_r_perf_mid_calf", { checked: true })).entry?.value.checked).toBe(true);
    expect((await save(visit, "ius_dvt", { freeText: "no" })).entry?.value.freeText).toBe("no");

    await expect(save(visit, "ius_l_ssv_status", { freeText: "maybe" })).rejects.toBeInstanceOf(InvalidClinicalValueError);
    await expect(save(visit, "ius_r_gsv_size_knee", { freeText: "400" })).rejects.toBeInstanceOf(InvalidClinicalValueError);

    const view = await getClinicalSectionForVisit(db, doctor, visit, INITIAL_US_EXAM_SECTION_CODE);
    const value = (code: string) => view.fields.find((f) => f.code === code)?.value;
    expect(value("ius_r_gsv_status")?.freeText).toBe("incompetent");
    expect(value("ius_r_perf_mid_calf")?.checked).toBe(true);
    expect(value("ius_l_perf_mid_calf")?.checked).not.toBe(true);
  });
});
